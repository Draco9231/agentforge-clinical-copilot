import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentAnswerSchema, chatRequestSchema } from './schemas.ts';

// Invariant: a well-formed submit_answer payload (what the model is expected to produce)
// parses cleanly. Guards against the schema being stricter than the tool's own input_schema.
test('agentAnswerSchema: accepts a well-formed submit_answer payload', () => {
	const result = agentAnswerSchema.safeParse({
		summary: 'Patient is on Lisinopril for hypertension.',
		citations: [{ claim: 'on Lisinopril', source_field: 'medications[0]' }],
		uncertain_about: [],
	});
	assert.equal(result.success, true);
});

// Boundary: the Anthropic tools API's input_schema is advisory, not enforced on the wire.
// A tool call missing citations entirely (a real failure mode, not hypothetical) must be
// rejected here rather than reaching verifyAnswer() as `undefined.filter(...)`.
test('agentAnswerSchema: rejects a tool call missing citations', () => {
	const result = agentAnswerSchema.safeParse({
		summary: 'Something.',
		uncertain_about: [],
	});
	assert.equal(result.success, false);
});

// Boundary: a citation with the wrong shape (source_field as a number instead of a string)
// must be rejected, not silently coerced — this is the failure mode strict schemas exist to
// catch that a bare `as AgentAnswer` cast cannot.
test('agentAnswerSchema: rejects a citation with a non-string source_field', () => {
	const result = agentAnswerSchema.safeParse({
		summary: 'Something.',
		citations: [{ claim: 'x', source_field: 0 }],
		uncertain_about: [],
	});
	assert.equal(result.success, false);
});

// Regression: load testing at 50 concurrent (2026-09-17) found the model's tool call sometimes
// truncates near max_tokens, dropping uncertain_about (the tool schema's last field) while
// summary/citations are already complete. This must degrade to an empty list, not reject the
// whole response outright — see the comment on agentAnswerSchema in schemas.ts.
test('agentAnswerSchema: defaults uncertain_about to [] when the field is missing (truncated tool call)', () => {
	const result = agentAnswerSchema.safeParse({
		summary: 'Patient is on Lisinopril for hypertension.',
		citations: [{ claim: 'on Lisinopril', source_field: 'medications[0]' }],
	});
	assert.equal(result.success, true);
	assert.deepEqual(result.data?.uncertain_about, []);
});

// Regression: the more common of the two observed failure modes in the same load test — the
// model returns uncertain_about as a bare string (e.g. "allergy history") instead of a
// one-element array. Must normalize, not reject.
test('agentAnswerSchema: normalizes a bare string uncertain_about into a one-element array', () => {
	const result = agentAnswerSchema.safeParse({
		summary: 'Patient is on Lisinopril for hypertension.',
		citations: [{ claim: 'on Lisinopril', source_field: 'medications[0]' }],
		uncertain_about: 'allergy history',
	});
	assert.equal(result.success, true);
	assert.deepEqual(result.data?.uncertain_about, ['allergy history']);
});

// Invariant: a well-formed /api/chat request parses.
test('chatRequestSchema: accepts a minimal valid request', () => {
	const result = chatRequestSchema.safeParse({ patientId: '123', message: 'What changed since last visit?' });
	assert.equal(result.success, true);
});

// Boundary: the pre-schema check was `!payload.patientId || !payload.message`, which is
// truthiness-based and lets an empty string for one field slip through if the other key is
// simply absent-but-truthy in a coerced sense. The schema must reject an empty message outright.
test('chatRequestSchema: rejects an empty message string', () => {
	const result = chatRequestSchema.safeParse({ patientId: '123', message: '' });
	assert.equal(result.success, false);
});

// Boundary: a history entry with an invalid role must be rejected rather than reaching the
// LLM prompt unchecked.
test('chatRequestSchema: rejects a history entry with an invalid role', () => {
	const result = chatRequestSchema.safeParse({
		patientId: '123',
		message: 'hi',
		history: [{ role: 'system', content: 'x' }],
	});
	assert.equal(result.success, false);
});

// Regression: found live against the real browser UI (2026-09-18), not by any curl-based test —
// ui.ts's `let conversationId = null` sends a literal JSON `null` on the first message of every
// conversation, not an omitted key. `.optional()` alone only permits `undefined` and rejected
// this, 400ing the opening message of every fresh conversation in the actual physician-facing
// UI since this schema was introduced. `.nullish()` must accept both.
test('chatRequestSchema: accepts a null conversationId and null history (the real first-message shape)', () => {
	const result = chatRequestSchema.safeParse({
		patientId: '123',
		message: "What's changed since her last visit?",
		conversationId: null,
		history: null,
	});
	assert.equal(result.success, true);
});
