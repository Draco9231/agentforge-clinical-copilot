import type { Env } from './types';
import { fetchPatientChart, OpenEmrAuthError } from './openemr';
import { askAgent } from './agent';
import { verifyAnswer } from './verify';
import { renderChatPage } from './ui';
import { chatRequestSchema, loginRequestSchema } from './schemas';
import { buildAuthorizeRedirect, readPkceSession, clearPkceCookie, exchangeCodeForToken } from './oauth';
import { sendLangfuseSpan } from './langfuse';

async function logStep(
	env: Env,
	ctx: ExecutionContext,
	correlationId: string,
	step: string,
	status: 'ok' | 'error' | 'degraded',
	latencyMs: number,
	detail?: unknown,
) {
	const payload = { correlationId, step, status, latencyMs, detail };
	console.log(JSON.stringify(payload));
	try {
		await env.DB.prepare(
			'INSERT INTO agent_logs (correlation_id, step, status, latency_ms, detail) VALUES (?, ?, ?, ?, ?)',
		)
			.bind(correlationId, step, status, latencyMs, detail ? JSON.stringify(detail).slice(0, 2000) : null)
			.run();
	} catch (e) {
		// Observability must never take the request down with it.
		console.error(JSON.stringify({ correlationId, step: 'logStep', status: 'error', error: String(e) }));
	}
	// Best-effort, non-blocking (see langfuse.ts) — a dashboard outage must never affect this.
	sendLangfuseSpan(env, ctx, { correlationId, step, status, latencyMs, detail });
}

function cors(res: Response): Response {
	const headers = new Headers(res.headers);
	headers.set('Access-Control-Allow-Origin', '*');
	headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
	headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	return new Response(res.body, { status: res.status, headers });
}

async function checkReady(env: Env): Promise<{ ready: boolean; checks: Record<string, string> }> {
	const checks: Record<string, string> = {};

	try {
		await env.DB.prepare('SELECT 1').first();
		checks.d1 = 'ok';
	} catch (e) {
		checks.d1 = `error: ${String(e)}`;
	}

	try {
		const res = await fetch(`${env.OPENEMR_BASE_URL}/apis/${env.OPENEMR_API_SITE}/fhir/metadata`);
		checks.openemr = res.ok ? 'ok' : `error: HTTP ${res.status}`;
	} catch (e) {
		checks.openemr = `error: ${String(e)}`;
	}

	checks.anthropic_key_present = env.ANTHROPIC_API_KEY ? 'ok' : 'error: missing ANTHROPIC_API_KEY';

	const ready = Object.values(checks).every((v) => v === 'ok');
	return { ready, checks };
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') {
			return cors(new Response(null, { status: 204 }));
		}

		if (url.pathname === '/health') {
			return new Response(JSON.stringify({ status: 'alive' }), { headers: { 'content-type': 'application/json' } });
		}

		if (url.pathname === '/ready') {
			const { ready, checks } = await checkReady(env);
			return new Response(JSON.stringify({ ready, checks }), {
				status: ready ? 200 : 503,
				headers: { 'content-type': 'application/json' },
			});
		}

		if (url.pathname === '/' && request.method === 'GET') {
			return new Response(renderChatPage(env.OPENEMR_BASE_URL, env.OPENEMR_API_SITE), {
				headers: { 'content-type': 'text/html; charset=utf-8' },
			});
		}

		// The physician-facing login flow (fixes ARCHITECTURE.md's known limitation 2, 2026-09-18):
		// authorization_code + PKCE against OpenEMR's own login page. This Worker never sees a
		// password — only a short-lived authorization code it exchanges server-side. The PKCE
		// verifier + CSRF state are carried across the redirect in an HttpOnly cookie (see
		// oauth.ts) since Workers have no session state between requests.
		if (url.pathname === '/login' && request.method === 'GET') {
			const redirectUri = `${url.origin}/callback`;
			const { location, setCookie } = await buildAuthorizeRedirect(env, redirectUri);
			return new Response(null, { status: 302, headers: { Location: location, 'Set-Cookie': setCookie } });
		}

		if (url.pathname === '/callback' && request.method === 'GET') {
			const correlationId = crypto.randomUUID();
			const code = url.searchParams.get('code');
			const returnedState = url.searchParams.get('state');
			const session = readPkceSession(request.headers.get('Cookie'));

			if (!code || !returnedState || !session) {
				return new Response('Login session expired or missing. Please try logging in again.', { status: 400 });
			}
			if (session.state !== returnedState) {
				await logStep(env, ctx, correlationId, 'auth:callback', 'error', 0, { reason: 'state_mismatch' });
				return new Response('Login could not be verified (state mismatch). Please try logging in again.', { status: 400 });
			}

			const start = Date.now();
			const redirectUri = `${url.origin}/callback`;
			const result = await exchangeCodeForToken(env, code, session.codeVerifier, redirectUri);
			await logStep(env, ctx, correlationId, 'auth:callback', result.ok ? 'ok' : 'error', Date.now() - start, {
				httpStatus: result.httpStatus,
			});

			const clearCookieHeaders = { 'Set-Cookie': clearPkceCookie };
			if (!result.ok || !result.accessToken) {
				return new Response(`Login failed: ${result.error ?? 'unknown error'}`, { status: 400, headers: clearCookieHeaders });
			}

			// Hands the token to the browser via a same-origin landing page rather than a URL
			// fragment redirect, so it never touches server logs or browser history.
			const html = `<!DOCTYPE html><html><body>Logging in…<script>
sessionStorage.setItem('access_token', ${JSON.stringify(result.accessToken)});
location.replace('/');
</script></body></html>`;
			return new Response(html, {
				headers: { 'content-type': 'text/html; charset=utf-8', ...clearCookieHeaders },
			});
		}

		// Test/automation escape hatch only (load tests, eval scripts) — NOT the physician-facing
		// flow anymore, which is /login above. Kept because it lets scripts.load-test.mjs and the
		// eval suite authenticate non-interactively without a browser redirect round-trip; a real
		// physician session always goes through authorization_code + PKCE.
		if (url.pathname === '/api/login' && request.method === 'POST') {
			const correlationId = crypto.randomUUID();
			let loginBody: unknown;
			try {
				loginBody = await request.json();
			} catch {
				return cors(new Response(JSON.stringify({ error: 'invalid JSON body', correlationId }), { status: 400 }));
			}
			const loginParsed = loginRequestSchema.safeParse(loginBody);
			if (!loginParsed.success) {
				return cors(
					new Response(JSON.stringify({ error: 'username and password are required', correlationId }), { status: 400 }),
				);
			}
			const { username, password } = loginParsed.data;
			const start = Date.now();
			try {
				const basicAuth = btoa(`${env.OPENEMR_CLIENT_ID}:${env.OPENEMR_CLIENT_SECRET}`);
				const tokenRes = await fetch(`${env.OPENEMR_BASE_URL}/oauth2/${env.OPENEMR_API_SITE}/token`, {
					method: 'POST',
					headers: {
						'content-type': 'application/x-www-form-urlencoded',
						authorization: `Basic ${basicAuth}`,
					},
					body: new URLSearchParams({
						grant_type: 'password',
						client_id: env.OPENEMR_CLIENT_ID,
						scope: 'openid offline_access api:oemr api:fhir user/Patient.read user/Condition.read user/MedicationRequest.read user/Observation.read',
						user_role: 'users',
						username,
						password,
					}),
				});
				const body = (await tokenRes.json()) as any;
				await logStep(env, ctx, correlationId, 'auth:login', tokenRes.ok ? 'ok' : 'error', Date.now() - start, {
					httpStatus: tokenRes.status,
				});
				return cors(
					new Response(JSON.stringify(tokenRes.ok ? { access_token: body.access_token } : { error: body.error ?? 'login failed' }), {
						status: tokenRes.status,
						headers: { 'content-type': 'application/json' },
					}),
				);
			} catch (e) {
				await logStep(env, ctx, correlationId, 'auth:login', 'error', Date.now() - start, String(e));
				return cors(new Response(JSON.stringify({ error: 'OpenEMR unreachable' }), { status: 502 }));
			}
		}

		if (url.pathname === '/api/patients' && request.method === 'GET') {
			const auth = request.headers.get('Authorization');
			if (!auth) return cors(new Response(JSON.stringify({ error: 'missing Authorization' }), { status: 401 }));
			const res = await fetch(`${env.OPENEMR_BASE_URL}/apis/${env.OPENEMR_API_SITE}/fhir/Patient?_count=20`, {
				headers: { Authorization: auth, Accept: 'application/fhir+json' },
			});
			const body = await res.text();
			return cors(new Response(body, { status: res.status, headers: { 'content-type': 'application/json' } }));
		}

		if (url.pathname === '/api/chat' && request.method === 'POST') {
			const correlationId = crypto.randomUUID();
			const auth = request.headers.get('Authorization');
			if (!auth) {
				return cors(new Response(JSON.stringify({ error: 'missing Authorization', correlationId }), { status: 401 }));
			}
			const token = auth.replace(/^Bearer\s+/i, '');

			let chatBody: unknown;
			try {
				chatBody = await request.json();
			} catch {
				return cors(new Response(JSON.stringify({ error: 'invalid JSON body', correlationId }), { status: 400 }));
			}
			const chatParsed = chatRequestSchema.safeParse(chatBody);
			if (!chatParsed.success) {
				// "invalid request body", not "patientId and message are required": the latter was
				// wrong whenever a different field failed (found live 2026-09-18 — conversationId:
				// null failed here every time, and the old message pointed at the wrong fields
				// entirely). `details` always carries the actual zod issues; the top-level message
				// should not overclaim which field is the problem.
				return cors(
					new Response(JSON.stringify({ error: 'invalid request body', correlationId, details: chatParsed.error.issues }), {
						status: 400,
					}),
				);
			}
			const payload = chatParsed.data;

			const conversationId = payload.conversationId ?? crypto.randomUUID();
			const history = payload.history ?? [];

			let chart;
			const fetchStart = Date.now();
			try {
				chart = await fetchPatientChart(env, token, payload.patientId);
				await logStep(env, ctx, correlationId, 'tool:get_patient_chart', 'ok', Date.now() - fetchStart, {
					patientId: payload.patientId,
				});
			} catch (e) {
				if (e instanceof OpenEmrAuthError) {
					await logStep(env, ctx, correlationId, 'tool:get_patient_chart', 'error', Date.now() - fetchStart, {
						reason: 'auth',
						httpStatus: e.status,
					});
					return cors(
						new Response(JSON.stringify({ error: 'Not authorized to view this patient in OpenEMR', correlationId }), {
							status: e.status,
						}),
					);
				}
				await logStep(env, ctx, correlationId, 'tool:get_patient_chart', 'error', Date.now() - fetchStart, String(e));
				return cors(
					new Response(JSON.stringify({ error: 'Could not retrieve patient chart from OpenEMR', correlationId }), {
						status: 502,
					}),
				);
			}

			const llmStart = Date.now();
			let answer;
			try {
				answer = await askAgent(env, chart, payload.message, history);
				await logStep(env, ctx, correlationId, 'llm:call', 'ok', Date.now() - llmStart, { citationCount: answer.citations.length });
			} catch (e) {
				await logStep(env, ctx, correlationId, 'llm:call', 'error', Date.now() - llmStart, String(e));
				return cors(
					new Response(JSON.stringify({ error: 'The assistant is temporarily unavailable. Please retry.', correlationId }), {
						status: 502,
					}),
				);
			}

			const verifyStart = Date.now();
			const verification = verifyAnswer(answer, chart);
			await logStep(env, ctx, correlationId, 'verify', verification.status === 'blocked' ? 'error' : 'ok', Date.now() - verifyStart, {
				status: verification.status,
				droppedClaims: verification.droppedClaims,
			});

			try {
				await env.DB.prepare('INSERT OR IGNORE INTO conversations (id, openemr_user, patient_id) VALUES (?, ?, ?)')
					.bind(conversationId, 'unknown', payload.patientId)
					.run();
				await env.DB.batch([
					env.DB.prepare(
						'INSERT INTO messages (id, conversation_id, correlation_id, role, content) VALUES (?, ?, ?, ?, ?)',
					).bind(crypto.randomUUID(), conversationId, correlationId, 'user', payload.message),
					env.DB.prepare(
						'INSERT INTO messages (id, conversation_id, correlation_id, role, content, verification_status) VALUES (?, ?, ?, ?, ?, ?)',
					).bind(crypto.randomUUID(), conversationId, correlationId, 'assistant', answer.summary, verification.status),
				]);
			} catch (e) {
				await logStep(env, ctx, correlationId, 'persist:messages', 'error', 0, String(e));
			}

			return cors(
				new Response(
					JSON.stringify({
						conversationId,
						correlationId,
						summary: answer.summary,
						citations: answer.citations,
						uncertainAbout: answer.uncertain_about,
						verificationStatus: verification.status,
						droppedClaims: verification.droppedClaims,
					}),
					{ headers: { 'content-type': 'application/json' } },
				),
			);
		}

		return cors(new Response('Not found', { status: 404 }));
	},
} satisfies ExportedHandler<Env>;
