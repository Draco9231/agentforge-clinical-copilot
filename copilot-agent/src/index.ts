import type { Env } from './types';
import { fetchPatientChart, OpenEmrAuthError } from './openemr';
import { askAgent, ModelCallError } from './agent';
import { verifyAnswer } from './verify';
import { judgeFaithfulness } from './judge';
import { estimateCostUsd } from './cost';
import { renderChatPage } from './ui';
import { chatRequestSchema, loginRequestSchema } from './schemas';
import { buildAuthorizeRedirect, readPkceSession, clearPkceCookie, exchangeCodeForToken, SCOPES } from './oauth';
import { sendLangfuseSpan } from './langfuse';
import { extractLabPdf, ExtractionError } from './extraction';
import { resolveNumericPid, uploadDocumentToOpenEmr } from './openemr-documents';

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

// The token's `sub` claim is the OpenEMR user's UUID. Decoding it (no signature check needed —
// OpenEMR already validated the token on every FHIR call this request makes) is enough to
// attribute conversations to the real physician instead of the placeholder 'unknown' every
// session used to write, which made cross-session/day history impossible to scope per user.
function getOpenemrUserId(token: string): string {
	try {
		const payload = token.split('.')[1];
		const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
		const parsed = JSON.parse(json);
		return typeof parsed.sub === 'string' ? parsed.sub : 'unknown';
	} catch {
		return 'unknown';
	}
}

// String.fromCharCode(...bytes) blows the call stack on a real multi-page PDF (tens of KB+) —
// chunking avoids spreading a large typed array into a single function call.
function arrayBufferToBase64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let binary = '';
	const chunkSize = 8192;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
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
						scope: SCOPES,
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

		// Week 2: attach_and_extract. Accepts a lab PDF, extracts structured cited facts via
		// Claude's native PDF+citations support, best-effort stores the source in OpenEMR (see
		// openemr-documents.ts for why that write can't be verified read back), and persists the
		// extraction — our own D1 documents/document_facts tables, not OpenEMR — as the durable
		// record citations point at.
		if (url.pathname === '/api/documents/attach_and_extract' && request.method === 'POST') {
			const correlationId = crypto.randomUUID();
			const auth = request.headers.get('Authorization');
			if (!auth) return cors(new Response(JSON.stringify({ error: 'missing Authorization', correlationId }), { status: 401 }));
			const token = auth.replace(/^Bearer\s+/i, '');

			let form: FormData;
			try {
				form = await request.formData();
			} catch {
				return cors(new Response(JSON.stringify({ error: 'expected multipart/form-data', correlationId }), { status: 400 }));
			}
			const patientId = form.get('patientId');
			const docType = form.get('doc_type');
			const file = form.get('file');
			if (typeof patientId !== 'string' || !patientId) {
				return cors(new Response(JSON.stringify({ error: 'patientId is required', correlationId }), { status: 400 }));
			}
			if (docType !== 'lab_pdf') {
				// intake_form is Part 2 scope — refusing explicitly here is more honest than a
				// silent no-op or a misleading 200 for a doc_type this endpoint doesn't handle yet.
				return cors(
					new Response(JSON.stringify({ error: 'only doc_type "lab_pdf" is supported so far', correlationId }), { status: 400 }),
				);
			}
			if (!(file instanceof File)) {
				return cors(new Response(JSON.stringify({ error: 'file is required', correlationId }), { status: 400 }));
			}

			const documentId = crypto.randomUUID();
			const fileBytes = await file.arrayBuffer();
			const openemrUserId = getOpenemrUserId(token);

			const extractStart = Date.now();
			let extraction;
			let usage;
			try {
				const result = await extractLabPdf(env, arrayBufferToBase64(fileBytes), documentId);
				extraction = result.extraction;
				usage = result.usage;
				await logStep(env, ctx, correlationId, 'extract:lab_pdf', 'ok', Date.now() - extractStart, {
					resultCount: extraction.results.length,
					extractionConfidence: extraction.extraction_confidence,
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					estimatedCostUsd: estimateCostUsd(usage),
				});
			} catch (e) {
				const errUsage = e instanceof ExtractionError ? e.usage : { inputTokens: 0, outputTokens: 0 };
				await logStep(env, ctx, correlationId, 'extract:lab_pdf', 'error', Date.now() - extractStart, {
					error: String(e),
					inputTokens: errUsage.inputTokens,
					outputTokens: errUsage.outputTokens,
					estimatedCostUsd: estimateCostUsd(errUsage),
				});
				return cors(
					new Response(JSON.stringify({ error: 'Could not extract structured data from this document', correlationId }), {
						status: 502,
					}),
				);
			}

			// Best-effort against OpenEMR — see openemr-documents.ts's documented bug. Failure here
			// never blocks the response: the extraction (this Worker's own D1 record) is the
			// durable result regardless of whether OpenEMR's copy round-tripped.
			const uploadStart = Date.now();
			const numericPid = await resolveNumericPid(env, token, patientId);
			let openemrUploadOk = false;
			if (numericPid !== null) {
				const uploadResult = await uploadDocumentToOpenEmr(env, token, numericPid, fileBytes, file.name, 'labreports');
				openemrUploadOk = uploadResult.uploaded;
				await logStep(env, ctx, correlationId, 'upload:openemr_document', uploadResult.uploaded ? 'ok' : 'error', Date.now() - uploadStart, {
					numericPid,
					error: uploadResult.error,
				});
			} else {
				await logStep(env, ctx, correlationId, 'upload:openemr_document', 'error', Date.now() - uploadStart, {
					reason: 'could not resolve numeric pid for patient uuid',
				});
			}

			try {
				await env.DB.prepare(
					'INSERT INTO documents (id, patient_id, openemr_user, doc_type, file_name, openemr_upload_ok, extraction_confidence, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
				)
					.bind(documentId, patientId, openemrUserId, 'lab_pdf', file.name, openemrUploadOk ? 1 : 0, extraction.extraction_confidence, correlationId)
					.run();
				if (extraction.results.length > 0) {
					await env.DB.batch(
						extraction.results.map((r) =>
							env.DB.prepare(
								'INSERT INTO document_facts (id, document_id, fact_json, source_type, source_id, page_or_section, field_or_chunk_id, quote_or_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
							).bind(
								crypto.randomUUID(),
								documentId,
								JSON.stringify(r),
								r.citation.source_type,
								r.citation.source_id,
								r.citation.page_or_section,
								r.citation.field_or_chunk_id,
								r.citation.quote_or_value,
							),
						),
					);
				}
			} catch (e) {
				await logStep(env, ctx, correlationId, 'persist:document', 'error', 0, String(e));
			}

			return cors(
				new Response(JSON.stringify({ documentId, correlationId, openemrUploadOk, ...extraction }), {
					headers: { 'content-type': 'application/json' },
				}),
			);
		}

		// Every message is already persisted per (openemr_user, patient_id) in D1 (see the
		// /api/chat insert below) — this just reads it back so switching patients, or coming back
		// tomorrow, shows that patient's prior conversation instead of starting blank each time.
		if (url.pathname === '/api/history' && request.method === 'GET') {
			const auth = request.headers.get('Authorization');
			if (!auth) return cors(new Response(JSON.stringify({ error: 'missing Authorization' }), { status: 401 }));
			const patientId = url.searchParams.get('patientId');
			if (!patientId) return cors(new Response(JSON.stringify({ error: 'patientId is required' }), { status: 400 }));
			const openemrUserId = getOpenemrUserId(auth.replace(/^Bearer\s+/i, ''));
			try {
				const result = await env.DB.prepare(
					`SELECT m.role as role, m.content as content, m.verification_status as verificationStatus, m.created_at as createdAt
					 FROM messages m
					 JOIN conversations c ON c.id = m.conversation_id
					 WHERE c.openemr_user = ? AND c.patient_id = ?
					 ORDER BY m.created_at ASC`,
				)
					.bind(openemrUserId, patientId)
					.all();
				return cors(
					new Response(JSON.stringify({ messages: result.results }), { headers: { 'content-type': 'application/json' } }),
				);
			} catch (e) {
				return cors(new Response(JSON.stringify({ error: 'could not load history' }), { status: 500 }));
			}
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

			// Week 2: fold facts extracted from uploaded documents into the chart the model reads and
			// the verifier checks. Runs only after fetchPatientChart succeeded, so OpenEMR's own
			// authorization has already been enforced for this user and patient — a restricted user
			// never reaches this query. Newest document first, deduped by test+date so re-uploading
			// the same report doesn't multiply identical facts in the prompt. Best-effort: a D1
			// failure degrades to the Week 1 behavior rather than failing the whole question.
			const docStart = Date.now();
			try {
				const rows = await env.DB.prepare(
					`SELECT f.fact_json AS fact_json, d.file_name AS file_name
					 FROM document_facts f JOIN documents d ON d.id = f.document_id
					 WHERE d.patient_id = ? ORDER BY d.created_at DESC, f.rowid ASC LIMIT 200`,
				)
					.bind(payload.patientId)
					.all<{ fact_json: string; file_name: string }>();
				const seen = new Set<string>();
				const facts: { text: string; source: string }[] = [];
				for (const row of rows.results ?? []) {
					const r = JSON.parse(row.fact_json);
					const key = `${r.test_name}|${r.collection_date ?? ''}`;
					if (seen.has(key)) continue;
					seen.add(key);
					const detail = [
						r.unit ? `${r.value} ${r.unit}` : r.value,
						r.reference_range ? `ref ${r.reference_range}` : null,
						`flag ${r.abnormal_flag}`,
						r.collection_date ? `collected ${r.collection_date}` : null,
					]
						.filter(Boolean)
						.join(', ');
					facts.push({ text: `${r.test_name}: ${detail}`, source: `uploaded ${r.citation.source_type} "${row.file_name}" p.${r.citation.page_or_section}` });
				}
				chart.documentFacts = facts;
				await logStep(env, ctx, correlationId, 'tool:get_document_facts', 'ok', Date.now() - docStart, { factCount: facts.length });
			} catch (e) {
				await logStep(env, ctx, correlationId, 'tool:get_document_facts', 'error', Date.now() - docStart, String(e));
			}

			const llmStart = Date.now();
			let answer;
			try {
				const askResult = await askAgent(env, chart, payload.message, history);
				answer = askResult.answer;
				// Found live (2026-09-18) auditing this project's own observability requirements: real
				// token usage/cost was never captured anywhere (see cost.ts). citationCount alone
				// answered "did it work," not "how many tokens, at what cost" — both explicitly
				// required by the case study's Observability section.
				await logStep(env, ctx, correlationId, 'llm:call', 'ok', Date.now() - llmStart, {
					citationCount: answer.citations.length,
					inputTokens: askResult.usage.inputTokens,
					outputTokens: askResult.usage.outputTokens,
					estimatedCostUsd: estimateCostUsd(askResult.usage),
				});
			} catch (e) {
				const usage = e instanceof ModelCallError ? e.usage : undefined;
				await logStep(env, ctx, correlationId, 'llm:call', 'error', Date.now() - llmStart, {
					error: String(e),
					...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: estimateCostUsd(usage) } : {}),
				});
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

			// Second-pass faithfulness check (judge.ts) — addresses ARCHITECTURE.md's known
			// limitation (1): the existence check above only confirms a citation's field exists, not
			// that the claim is a faithful representation of it. Fails open: a judge-call error never
			// blocks the response — only the existence check above is the safety-critical gate.
			// Skipped when there's nothing to judge (no surviving citations).
			let unfaithfulClaims: string[] = [];
			let finalStatus = verification.status;
			if (verification.status !== 'blocked' && answer.citations.length > 0) {
				const judgeStart = Date.now();
				try {
					const judgeResult = await judgeFaithfulness(env, chart, answer);
					unfaithfulClaims = judgeResult.unfaithfulClaims;
					await logStep(env, ctx, correlationId, 'verify:judge', 'ok', Date.now() - judgeStart, {
						unfaithfulCount: unfaithfulClaims.length,
						inputTokens: judgeResult.usage.inputTokens,
						outputTokens: judgeResult.usage.outputTokens,
						estimatedCostUsd: estimateCostUsd(judgeResult.usage),
					});
					if (unfaithfulClaims.length > 0 && finalStatus === 'verified') {
						finalStatus = 'degraded';
					}
				} catch (e) {
					await logStep(env, ctx, correlationId, 'verify:judge', 'error', Date.now() - judgeStart, String(e));
				}
			}

			try {
				await env.DB.prepare('INSERT OR IGNORE INTO conversations (id, openemr_user, patient_id) VALUES (?, ?, ?)')
					.bind(conversationId, getOpenemrUserId(token), payload.patientId)
					.run();
				await env.DB.batch([
					env.DB.prepare(
						'INSERT INTO messages (id, conversation_id, correlation_id, role, content) VALUES (?, ?, ?, ?, ?)',
					).bind(crypto.randomUUID(), conversationId, correlationId, 'user', payload.message),
					env.DB.prepare(
						'INSERT INTO messages (id, conversation_id, correlation_id, role, content, verification_status) VALUES (?, ?, ?, ?, ?, ?)',
					).bind(crypto.randomUUID(), conversationId, correlationId, 'assistant', answer.summary, finalStatus),
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
						verificationStatus: finalStatus,
						droppedClaims: verification.droppedClaims,
						unfaithfulClaims,
					}),
					{ headers: { 'content-type': 'application/json' } },
				),
			);
		}

		return cors(new Response('Not found', { status: 404 }));
	},
} satisfies ExportedHandler<Env>;
