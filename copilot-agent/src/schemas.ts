import { z } from 'zod';

// Runtime contract for the model's submit_answer tool call. agent.ts's Anthropic
// tools API `input_schema` only constrains what the model is *asked* to produce —
// nothing on the wire enforces it actually complied. Without this, a malformed
// tool_use.input (missing citations, wrong types) reaches verifyAnswer() as an
// unchecked `as AgentAnswer` cast and crashes on `answer.citations.filter`.
export const agentAnswerSchema = z.object({
	summary: z.string(),
	citations: z.array(
		z.object({
			claim: z.string(),
			source_field: z.string(),
		}),
	),
	// Optional with a default, not required, and tolerant of a bare string: load testing at 50
	// concurrent (2026-09-17) found the model reliably mishandles this one field two ways —
	// omitting it (received: undefined) and, more often, returning a single string instead of a
	// one-element array (received: string) — while summary/citations (the safety-critical fields)
	// come back correctly every time. Neither is a reason to discard an otherwise-verified answer.
	uncertain_about: z.preprocess(
		(val) => (typeof val === 'string' ? [val] : val),
		z.array(z.string()).optional().default([]),
	),
});

// POST /api/chat request body. Replaces the ad-hoc `!payload.patientId || !payload.message`
// check, which only tested truthiness (accepted patientId: 123, rejected message: "") and
// left history/conversationId completely unchecked before they reached D1 and the LLM prompt.
export const chatRequestSchema = z.object({
	patientId: z.string().min(1),
	message: z.string().min(1),
	// Found live testing the real browser UI (2026-09-18), not caught by any curl-based test:
	// ui.ts's `let conversationId = null` means the very first message of every conversation
	// sends a literal JSON `null`, not an omitted key. `.optional()` alone only permits
	// `undefined`, so this silently 400'd every fresh conversation's opening message in the
	// actual physician-facing UI since the day this schema was introduced — `.nullish()` accepts
	// both undefined and null, then the handler below normalizes null to undefined for the
	// `?? crypto.randomUUID()` fallback in index.ts to see it as absent.
	conversationId: z.string().min(1).nullish(),
	history: z
		.array(
			z.object({
				role: z.enum(['user', 'assistant']),
				content: z.string(),
			}),
		)
		.nullish(),
});

// POST /api/login request body.
export const loginRequestSchema = z.object({
	username: z.string().min(1),
	password: z.string().min(1),
});

// Week 2 citation contract (W2 PRD, "Citation contract"): every extracted clinical fact must
// carry machine-readable provenance, not just a prose citation like Week 1's `source_field`.
// source_id is our own D1 document id (see documents.ts) — never OpenEMR's, since OpenEMR's own
// document-read API cannot reliably confirm what it stored (see openemr-documents.ts).
export const citationSchema = z.object({
	source_type: z.enum(['lab_pdf', 'intake_form']),
	source_id: z.string(),
	page_or_section: z.string(),
	field_or_chunk_id: z.string(),
	quote_or_value: z.string(),
});

// Required lab fields per the W2 PRD: test name, value, unit, reference range, collection date,
// abnormal flag, source citation. unit/reference_range/collection_date are nullish because a
// real scanned lab PDF frequently omits one of these per-row — treating them as required would
// force the model to invent a value rather than leave it genuinely absent.
export const labResultSchema = z.object({
	test_name: z.string(),
	value: z.string(),
	unit: z.string().nullish(),
	reference_range: z.string().nullish(),
	collection_date: z.string().nullish(),
	abnormal_flag: z.enum(['normal', 'high', 'low', 'critical', 'unknown']),
	citation: citationSchema,
});

export const labPdfExtractionSchema = z.object({
	results: z.array(labResultSchema),
	// Surfaces the "vision extraction without invention" concern from the W2 PRD directly in the
	// schema rather than leaving it implicit — a low-confidence extraction should be visibly
	// flagged to the physician, not silently presented with the same weight as a clean one.
	extraction_confidence: z.enum(['high', 'medium', 'low']),
	unparsed_notes: z.array(z.string()).optional().default([]),
});

// judge.ts's second-pass faithfulness check tool output. Same reasoning as agentAnswerSchema:
// the Anthropic tools API's input_schema is advisory, not enforced on the wire, and this result
// feeds directly into what verification status gets shown to a physician — it needs the same
// runtime guarantee as the primary answer, not a bare cast.
export const judgeResultSchema = z.object({
	unfaithfulClaims: z.array(z.string()).optional().default([]),
});
