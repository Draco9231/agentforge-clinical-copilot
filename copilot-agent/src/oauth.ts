import type { Env } from './types';

// authorization_code + PKCE, replacing the password-grant stopgap documented in
// ARCHITECTURE.md's known limitations. The physician now authenticates directly against
// OpenEMR's own login page — this Worker never sees a password, only ever a short-lived
// authorization code it exchanges server-side. PKCE is defense-in-depth on top of the
// client_secret this confidential client already holds (registered client_secret_post),
// not a substitute for it — belt and suspenders, not either/or.
const SCOPES =
	'openid offline_access api:oemr api:fhir user/Patient.read user/Condition.read user/MedicationRequest.read user/Observation.read';

const PKCE_COOKIE = 'oauth_pkce';

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomUrlSafeString(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

export async function pkceChallengeFromVerifier(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return base64UrlEncode(new Uint8Array(digest));
}

function oauthBase(env: Env): string {
	return `${env.OPENEMR_BASE_URL}/oauth2/${env.OPENEMR_API_SITE}`;
}

export interface PkceSession {
	codeVerifier: string;
	state: string;
}

// Builds the redirect to OpenEMR's own login/consent screen and the cookie that carries the
// PKCE verifier + CSRF state across that redirect. Workers are stateless between requests, and
// a cookie (HttpOnly so page JS can't read it, short-lived, scoped to this flow) is the standard
// way to bridge that — the alternative (a server-side session store) is unwarranted complexity
// for a value that only needs to survive one redirect round-trip.
export async function buildAuthorizeRedirect(env: Env, redirectUri: string): Promise<{ location: string; setCookie: string }> {
	const codeVerifier = randomUrlSafeString(48);
	const state = randomUrlSafeString(16);
	const codeChallenge = await pkceChallengeFromVerifier(codeVerifier);

	const authorizeUrl = new URL(`${oauthBase(env)}/authorize`);
	authorizeUrl.searchParams.set('response_type', 'code');
	authorizeUrl.searchParams.set('client_id', env.OPENEMR_CLIENT_ID);
	authorizeUrl.searchParams.set('redirect_uri', redirectUri);
	authorizeUrl.searchParams.set('scope', SCOPES);
	authorizeUrl.searchParams.set('state', state);
	authorizeUrl.searchParams.set('code_challenge', codeChallenge);
	authorizeUrl.searchParams.set('code_challenge_method', 'S256');

	const session: PkceSession = { codeVerifier, state };
	const cookieValue = encodeURIComponent(JSON.stringify(session));
	// Max-Age=300: a login should take seconds, not minutes; short-lived on purpose so a stale
	// cookie can't be replayed against a later, unrelated authorize attempt.
	const setCookie = `${PKCE_COOKIE}=${cookieValue}; HttpOnly; Secure; SameSite=Lax; Max-Age=300; Path=/`;

	return { location: authorizeUrl.toString(), setCookie };
}

export function readPkceSession(cookieHeader: string | null): PkceSession | null {
	if (!cookieHeader) return null;
	const match = cookieHeader.match(new RegExp(`${PKCE_COOKIE}=([^;]+)`));
	if (!match) return null;
	try {
		const parsed = JSON.parse(decodeURIComponent(match[1]));
		if (typeof parsed?.codeVerifier === 'string' && typeof parsed?.state === 'string') {
			return parsed as PkceSession;
		}
		return null;
	} catch {
		return null;
	}
}

export const clearPkceCookie = `${PKCE_COOKIE}=; Max-Age=0; Path=/`;

export interface TokenExchangeResult {
	ok: boolean;
	accessToken?: string;
	error?: string;
	httpStatus: number;
}

export async function exchangeCodeForToken(
	env: Env,
	code: string,
	codeVerifier: string,
	redirectUri: string,
): Promise<TokenExchangeResult> {
	const res = await fetch(`${oauthBase(env)}/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
			client_id: env.OPENEMR_CLIENT_ID,
			client_secret: env.OPENEMR_CLIENT_SECRET,
			code_verifier: codeVerifier,
		}),
	});
	const body = (await res.json()) as any;
	return {
		ok: res.ok,
		accessToken: res.ok ? body.access_token : undefined,
		error: res.ok ? undefined : (body.error ?? 'token exchange failed'),
		httpStatus: res.status,
	};
}
