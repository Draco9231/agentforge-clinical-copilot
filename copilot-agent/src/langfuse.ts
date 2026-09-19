import type { Env } from './types';

// Sends the exact same non-PHI metadata already written to agent_logs (step, status, latency,
// small detail blob) to Langfuse — never chart data, never full model prompts/completions. This
// mirrors the project's own PHI boundary (ARCHITECTURE.md / AUDIT.md's compliance section): if
// patient data and full completions don't leave OpenEMR/Anthropic, they don't leave to a
// third-party observability tool either. One Langfuse trace per correlationId (the same ID
// already in every log line and D1 row), one span per step.
//
// Fire-and-forget via ctx.waitUntil: a slow or unreachable Langfuse must never add latency to
// the physician-facing request, or become a new failure mode — the same "observability must
// never take the request down with it" rule logStep already follows for D1 writes.
//
// KNOWN, DATED FOLLOW-UP: this uses Langfuse's legacy v3 `POST /api/public/ingestion` batch
// API. Confirmed live (2026-09-18) via that endpoint's own response: it sunsets 2026-11-16, after
// which it accepts only score-create events and rejects trace/span-create entirely — this
// integration would go silently dark past that date. Well past this project's Sunday final
// deadline, so shipping on the legacy API now rather than building OTLP ingestion
// (`POST /api/public/otel/v1/traces`) this close to that deadline is a deliberate, documented
// tradeoff, not an oversight — migrate before 2026-11-16.
export function isConfigured(env: Env): boolean {
	return Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
}

export interface SpanParams {
	correlationId: string;
	step: string;
	status: 'ok' | 'error' | 'degraded';
	latencyMs: number;
	detail?: unknown;
}

// Pure and separately tested: the two failure modes worth guarding against are a negative
// startTime (if latencyMs were ever negative — a caller bug, not a Langfuse one) producing a
// timestamp after endTime, and `detail` accidentally carrying something Langfuse's `metadata`
// can't serialize. Kept separate from sendLangfuseSpan so this shape can be checked without a
// live Langfuse account or a fetch mock.
export function buildIngestionBatch(params: SpanParams, now: Date = new Date()) {
	const nowIso = now.toISOString();
	const startTime = new Date(now.getTime() - Math.max(params.latencyMs, 0)).toISOString();

	return [
		// Upsert semantics on trace-create mean sending this alongside every span is safe and
		// idempotent — no need to track "is this the first event for this correlationId."
		{
			id: crypto.randomUUID(),
			timestamp: nowIso,
			type: 'trace-create',
			body: { id: params.correlationId, name: 'clinical-copilot-request', timestamp: nowIso },
		},
		{
			id: crypto.randomUUID(),
			timestamp: nowIso,
			type: 'span-create',
			body: {
				id: crypto.randomUUID(),
				traceId: params.correlationId,
				name: params.step,
				startTime,
				endTime: nowIso,
				level: params.status === 'error' ? 'ERROR' : params.status === 'degraded' ? 'WARNING' : 'DEFAULT',
				metadata: params.detail ?? undefined,
			},
		},
	];
}

export function sendLangfuseSpan(env: Env, ctx: ExecutionContext, params: SpanParams): void {
	if (!isConfigured(env)) return;

	const batch = buildIngestionBatch(params);
	const host = env.LANGFUSE_HOST || 'https://cloud.langfuse.com';
	const auth = btoa(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`);

	// fetch() only rejects on network failure — it resolves normally for 4xx/5xx responses. Found
	// live (2026-09-18): the first deploy of this integration checked neither `res.ok` nor the
	// response body, so a rejected ingestion (wrong auth encoding, malformed batch, etc.) would
	// have silently "succeeded" from this code's perspective while Langfuse silently dropped it —
	// exactly the kind of error this project doesn't accept elsewhere (see agent.ts's own care
	// around the same class of bug). Must read the body on failure to have any chance of debugging it.
	const send = fetch(`${host}/api/public/ingestion`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
		body: JSON.stringify({ batch }),
	})
		.then(async (res) => {
			if (!res.ok) {
				const body = await res.text();
				console.error(JSON.stringify({ step: 'langfuse:send', status: 'error', httpStatus: res.status, body: body.slice(0, 500) }));
			}
		})
		.catch((e) => {
			console.error(JSON.stringify({ step: 'langfuse:send', status: 'error', error: String(e) }));
		});

	ctx.waitUntil(send);
}
