import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUrlSafeString, pkceChallengeFromVerifier, readPkceSession } from './oauth.ts';

// Invariant: the code_verifier is a fixed-length, URL-safe string every time (Base64url of N
// random bytes has no padding to strip inconsistently, but confirms the encoding never leaks a
// '+', '/', or '=' into a query string or Set-Cookie header).
test('randomUrlSafeString: produces a URL-safe string of consistent length', () => {
	const s = randomUrlSafeString(48);
	assert.match(s, /^[A-Za-z0-9_-]+$/);
	assert.equal(s.length, 64); // base64 of 48 bytes, no padding
});

// Regression: verified against the RFC 7636 (PKCE) Appendix B test vector, so this isn't just
// "some SHA-256 base64url encoding" — it's the exact one OAuth servers expect.
test('pkceChallengeFromVerifier: matches the RFC 7636 Appendix B test vector', async () => {
	const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
	const challenge = await pkceChallengeFromVerifier(verifier);
	assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

// Boundary: no cookie header at all (first visit, or a client that stripped it) must not throw.
test('readPkceSession: returns null when there is no cookie header', () => {
	assert.equal(readPkceSession(null), null);
});

// Boundary: a cookie header present but without our specific cookie (e.g. only unrelated
// cookies) must not throw or false-positive match.
test('readPkceSession: returns null when the pkce cookie is absent', () => {
	assert.equal(readPkceSession('other_cookie=abc; another=def'), null);
});

// Invariant: a well-formed cookie round-trips back to the same session values.
test('readPkceSession: round-trips a well-formed cookie', () => {
	const session = { codeVerifier: 'verifier-value', state: 'state-value' };
	const cookie = `oauth_pkce=${encodeURIComponent(JSON.stringify(session))}`;
	assert.deepEqual(readPkceSession(cookie), session);
});

// Boundary: a malformed/tampered cookie value must fail closed (null), not throw and crash the
// callback handler — a login session expiring should surface as "please try again," not a 500.
test('readPkceSession: returns null for malformed cookie content, not a throw', () => {
	assert.equal(readPkceSession('oauth_pkce=not-valid-json'), null);
});
