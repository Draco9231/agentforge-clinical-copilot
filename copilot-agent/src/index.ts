import type { Env } from './types';
import { fetchPatientChart, OpenEmrAuthError } from './openemr';
import { askAgent, type ConversationTurn } from './agent';
import { verifyAnswer } from './verify';
import { renderChatPage } from './ui';

async function logStep(
	env: Env,
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
	async fetch(request: Request, env: Env): Promise<Response> {
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

		// Proxies the OAuth2 password-grant login to OpenEMR so the browser never
		// needs OpenEMR's origin allowed for CORS. Known limitation: this Worker
		// sees the plaintext password in transit for the moment of login (not
		// stored, not logged). Documented in ARCHITECTURE.md as a stopgap for
		// today's demo shell only — production must move to authorization_code
		// + PKCE so credentials never pass through this service at all.
		if (url.pathname === '/api/login' && request.method === 'POST') {
			const correlationId = crypto.randomUUID();
			const { username, password } = (await request.json()) as { username: string; password: string };
			const start = Date.now();
			try {
				const tokenRes = await fetch(`${env.OPENEMR_BASE_URL}/oauth2/${env.OPENEMR_API_SITE}/token`, {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({
						grant_type: 'password',
						client_id: 'clinical-copilot-demo',
						scope: 'openid api:oemr api:fhir user/Patient.read user/Condition.read user/MedicationRequest.read user/Observation.read',
						user_role: 'users',
						username,
						password,
					}),
				});
				const body = (await tokenRes.json()) as any;
				await logStep(env, correlationId, 'auth:login', tokenRes.ok ? 'ok' : 'error', Date.now() - start, {
					httpStatus: tokenRes.status,
				});
				return cors(
					new Response(JSON.stringify(tokenRes.ok ? { access_token: body.access_token } : { error: body.error ?? 'login failed' }), {
						status: tokenRes.status,
						headers: { 'content-type': 'application/json' },
					}),
				);
			} catch (e) {
				await logStep(env, correlationId, 'auth:login', 'error', Date.now() - start, String(e));
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

			let payload: { patientId: string; message: string; conversationId?: string; history?: ConversationTurn[] };
			try {
				payload = await request.json();
			} catch {
				return cors(new Response(JSON.stringify({ error: 'invalid JSON body', correlationId }), { status: 400 }));
			}
			if (!payload.patientId || !payload.message) {
				return cors(new Response(JSON.stringify({ error: 'patientId and message are required', correlationId }), { status: 400 }));
			}

			const conversationId = payload.conversationId ?? crypto.randomUUID();
			const history = payload.history ?? [];

			let chart;
			const fetchStart = Date.now();
			try {
				chart = await fetchPatientChart(env, token, payload.patientId);
				await logStep(env, correlationId, 'tool:get_patient_chart', 'ok', Date.now() - fetchStart, {
					patientId: payload.patientId,
				});
			} catch (e) {
				if (e instanceof OpenEmrAuthError) {
					await logStep(env, correlationId, 'tool:get_patient_chart', 'error', Date.now() - fetchStart, {
						reason: 'auth',
						httpStatus: e.status,
					});
					return cors(
						new Response(JSON.stringify({ error: 'Not authorized to view this patient in OpenEMR', correlationId }), {
							status: e.status,
						}),
					);
				}
				await logStep(env, correlationId, 'tool:get_patient_chart', 'error', Date.now() - fetchStart, String(e));
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
				await logStep(env, correlationId, 'llm:call', 'ok', Date.now() - llmStart, { citationCount: answer.citations.length });
			} catch (e) {
				await logStep(env, correlationId, 'llm:call', 'error', Date.now() - llmStart, String(e));
				return cors(
					new Response(JSON.stringify({ error: 'The assistant is temporarily unavailable. Please retry.', correlationId }), {
						status: 502,
					}),
				);
			}

			const verifyStart = Date.now();
			const verification = verifyAnswer(answer, chart);
			await logStep(env, correlationId, 'verify', verification.status === 'blocked' ? 'error' : 'ok', Date.now() - verifyStart, {
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
				await logStep(env, correlationId, 'persist:messages', 'error', 0, String(e));
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
