import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isConfigured, buildIngestionBatch } from './langfuse.ts';
import type { Env } from './types.ts';

const baseEnv = { DB: {} as any, OPENEMR_BASE_URL: '', OPENEMR_API_SITE: '', OPENEMR_CLIENT_ID: '', OPENEMR_CLIENT_SECRET: '', ANTHROPIC_API_KEY: '' };

// Invariant: dashboard tracing is opt-in. Before setup (or in local dev without the secrets),
// this must read as "not configured" rather than throwing or silently sending to a default host
// with empty credentials.
test('isConfigured: false when the Langfuse keys are absent', () => {
	assert.equal(isConfigured(baseEnv as Env), false);
});

test('isConfigured: true once both keys are present', () => {
	assert.equal(isConfigured({ ...baseEnv, LANGFUSE_PUBLIC_KEY: 'pk-x', LANGFUSE_SECRET_KEY: 'sk-x' } as Env), true);
});

// Invariant: the batch always contains exactly one trace-create (upsert-safe) and one
// span-create tied to it by traceId — the shape Langfuse's ingestion API expects.
test('buildIngestionBatch: produces one trace-create and one span-create linked by traceId', () => {
	const batch = buildIngestionBatch({ correlationId: 'corr-1', step: 'tool:get_patient_chart', status: 'ok', latencyMs: 250 });
	assert.equal(batch.length, 2);
	assert.equal(batch[0].type, 'trace-create');
	assert.equal(batch[0].body.id, 'corr-1');
	assert.equal(batch[1].type, 'span-create');
	assert.equal(batch[1].body.traceId, 'corr-1');
	assert.equal(batch[1].body.name, 'tool:get_patient_chart');
});

// Boundary: latencyMs of 0 (a synchronous failure logged before any real work started, e.g. the
// state-mismatch case in index.ts) must not throw and must produce startTime === endTime, not a
// negative-duration span.
test('buildIngestionBatch: zero latency produces a zero-duration span, not a throw', () => {
	const now = new Date('2026-09-18T12:00:00.000Z');
	const batch = buildIngestionBatch({ correlationId: 'corr-2', step: 'auth:callback', status: 'error', latencyMs: 0 }, now);
	assert.equal(batch[1].body.startTime, batch[1].body.endTime);
});

// Regression: a negative latencyMs (would only happen from a caller bug, e.g. clock skew) must
// not produce a startTime *after* endTime — that would render as a nonsensical negative-duration
// span in the dashboard instead of failing loudly where the bug actually is.
test('buildIngestionBatch: clamps a negative latencyMs instead of producing startTime after endTime', () => {
	const now = new Date('2026-09-18T12:00:00.000Z');
	const batch = buildIngestionBatch({ correlationId: 'corr-3', step: 'verify', status: 'ok', latencyMs: -50 }, now);
	assert.ok(new Date(batch[1].body.startTime).getTime() <= new Date(batch[1].body.endTime).getTime());
});

// Invariant: status maps to Langfuse's expected severity levels — 'error' must be visually
// distinct (ERROR) from a normal step, since that's the whole point of shipping this to a
// dashboard instead of just D1.
test('buildIngestionBatch: maps status to the corresponding Langfuse level', () => {
	const ok = buildIngestionBatch({ correlationId: 'c', step: 's', status: 'ok', latencyMs: 1 });
	const err = buildIngestionBatch({ correlationId: 'c', step: 's', status: 'error', latencyMs: 1 });
	const degraded = buildIngestionBatch({ correlationId: 'c', step: 's', status: 'degraded', latencyMs: 1 });
	assert.equal(ok[1].body.level, 'DEFAULT');
	assert.equal(err[1].body.level, 'ERROR');
	assert.equal(degraded[1].body.level, 'WARNING');
});

// Boundary: no detail blob provided (e.g. a plain string error passed elsewhere) must not throw.
test('buildIngestionBatch: handles an absent detail without throwing', () => {
	const batch = buildIngestionBatch({ correlationId: 'c', step: 's', status: 'ok', latencyMs: 1 });
	assert.equal(batch[1].body.metadata, undefined);
});
