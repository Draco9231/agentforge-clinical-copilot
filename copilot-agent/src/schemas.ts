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
