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
	uncertain_about: z.array(z.string()),
});

// POST /api/chat request body. Replaces the ad-hoc `!payload.patientId || !payload.message`
// check, which only tested truthiness (accepted patientId: 123, rejected message: "") and
// left history/conversationId completely unchecked before they reached D1 and the LLM prompt.
export const chatRequestSchema = z.object({
	patientId: z.string().min(1),
	message: z.string().min(1),
	conversationId: z.string().min(1).optional(),
	history: z
		.array(
			z.object({
				role: z.enum(['user', 'assistant']),
				content: z.string(),
			}),
		)
		.optional(),
});

// POST /api/login request body.
export const loginRequestSchema = z.object({
	username: z.string().min(1),
	password: z.string().min(1),
});
