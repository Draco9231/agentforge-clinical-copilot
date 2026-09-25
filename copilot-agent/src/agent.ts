import type { AgentAnswer, Env, PatientChart } from './types';
import { flattenChart } from './verify';
import { agentAnswerSchema } from './schemas';
import { sumUsage, type ModelUsage } from './cost';

const SUBMIT_ANSWER_TOOL = {
	name: 'submit_answer',
	description:
		"Submit your final answer to the physician. Every factual claim about the patient's " +
		'chart MUST be listed in citations with the exact source_field key it came from. ' +
		'Never state a fact about the patient that is not backed by a citation. If something ' +
		"the physician asked about isn't in the provided chart data, list it in uncertain_about " +
		'instead of guessing.',
	input_schema: {
		type: 'object',
		properties: {
			summary: { type: 'string', description: 'The answer in plain clinical language, ready to read in about 90 seconds: brief, prioritized, no more than 4 points for a broad question.' },
			citations: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						claim: { type: 'string', description: 'The specific factual claim made in the summary.' },
						source_field: { type: 'string', description: 'The exact field key from the provided chart data, e.g. medications[0].' },
					},
					required: ['claim', 'source_field'],
				},
			},
			uncertain_about: {
				type: 'array',
				items: { type: 'string' },
				description: "Things the physician asked about that aren't answerable from the provided chart data.",
			},
		},
		required: ['summary', 'citations', 'uncertain_about'],
	},
};

export interface ConversationTurn {
	role: 'user' | 'assistant';
	content: string;
}

export interface AskAgentResult {
	answer: AgentAnswer;
	usage: ModelUsage;
}

// Exported so the eval gate can assert the instructions that carry safety and latency weight are
// still present (evals/golden.json, kind "prompt") — a prompt is code that a refactor can quietly
// weaken, and nothing else would notice.
export function buildSystemPrompt(chartBlock: string): string {
	return (
		'You are a Clinical Co-Pilot embedded in OpenEMR, helping a physician between patient rooms. ' +
		'You only know what is in the chart data below for THIS patient. Do not use outside medical ' +
		'knowledge to state facts about this patient. You may use general clinical knowledge only to ' +
		'explain why something might matter, clearly separated from chart facts. Fields named ' +
		'guidelineEvidence[n] are general clinical-guideline excerpts, NOT facts about this patient: ' +
		'cite them only for what a guideline recommends, always attribute the recommendation to its ' +
		'named source, and never state one as something true of this patient. Fields named ' +
		'documentFacts[n] came from a document uploaded for this patient.\n\n' +
		'BE BRIEF. The physician has about 90 seconds. For a broad question ("what should I pay ' +
		'attention to?", "what changed?"), give at most 4 points, most important first, each ONE ' +
		'sentence with its citation. Prioritize: (1) values out of range or off a guideline goal, ' +
		'(2) discrepancies between sources (e.g. a medication the patient reports that is not in the ' +
		'chart), (3) safety items such as allergies, (4) what changed. Do not list normal values or ' +
		'restate the chart. End with one short line naming what you can expand on. For a narrow ' +
		'factual question ("what meds is he on?"), answer just that, completely and directly, with no ' +
		'extras. Brevity never permits dropping a citation or a safety-relevant item: if something ' +
		'important cannot fit, say so in uncertain_about. Always respond by calling submit_answer.\n\n' +
		'Chart data (field_key: value):\n' +
		chartBlock
	);
}

export async function askAgent(
	env: Env,
	chart: PatientChart,
	question: string,
	history: ConversationTurn[],
): Promise<AskAgentResult> {
	const fields = flattenChart(chart);
	const chartBlock = Object.entries(fields)
		.map(([key, value]) => `- ${key}: ${value}`)
		.join('\n');

	const system = buildSystemPrompt(chartBlock);

	const messages = [
		...history.map((h) => ({ role: h.role, content: h.content })),
		{ role: 'user' as const, content: question },
	];

	// Live-tested finding (2026-09-17, both under 50-concurrent load AND on a single unconcurrent
	// request): the model occasionally omits `citations` from the submit_answer call entirely —
	// this isn't a concurrency artifact, it's the tool call's own non-determinism. One bounded
	// retry (not a loop) trades a few seconds of latency for not failing a request outright over
	// a re-askable model quirk; if the retry also fails, something is actually wrong and it
	// should surface as an error rather than retry indefinitely.
	let lastError: unknown;
	let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const result = await callModel(env, system, messages);
			return { answer: result.answer, usage: sumUsage(usage, result.usage) };
		} catch (e) {
			lastError = e;
			// A failed attempt (e.g. malformed tool call) can still have consumed real, billed
			// tokens — ModelCallError carries usage precisely so a retried request's true cost
			// isn't undercounted just because the first attempt didn't produce a usable answer.
			if (e instanceof ModelCallError) usage = sumUsage(usage, e.usage);
		}
	}
	// Both attempts failed: re-throw with the accumulated usage from both, not just discard it —
	// a request that costs real tokens and still fails is exactly the case cost tracking must not
	// silently lose.
	throw new ModelCallError(lastError instanceof Error ? lastError.message : String(lastError), usage);
}

// Carries token usage alongside a call failure — found necessary because a failed attempt (e.g.
// a malformed tool call caught by agentAnswerSchema) can still have consumed real, billed
// tokens; without this, askAgent's retry path would silently undercount the true cost of a
// request that needed a retry.
export class ModelCallError extends Error {
	usage: ModelUsage;
	constructor(message: string, usage: ModelUsage) {
		super(message);
		this.usage = usage;
	}
}

async function callModel(
	env: Env,
	system: string,
	messages: { role: 'user' | 'assistant'; content: string }[],
): Promise<{ answer: AgentAnswer; usage: ModelUsage }> {
	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': env.ANTHROPIC_API_KEY,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({
			model: 'claude-sonnet-5',
			// Load-tested finding (2026-09-17): at 1024, concurrent load produced tool calls
			// truncated mid-generation, dropping the trailing `uncertain_about` field entirely
			// (confirmed via agent_logs: zod rejected "uncertain_about: undefined" ~18% of
			// requests at 50 concurrent). 4096 gives real headroom for a citation-heavy answer.
			max_tokens: 4096,
			system,
			messages,
			tools: [SUBMIT_ANSWER_TOOL],
			tool_choice: { type: 'tool', name: 'submit_answer' },
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		// No response body to read usage from on an HTTP-level failure.
		throw new ModelCallError(`Anthropic API error (${res.status}): ${body}`, { inputTokens: 0, outputTokens: 0 });
	}

	const data = (await res.json()) as any;
	// Found live (2026-09-18) auditing this project's own observability requirements: Anthropic's
	// response carries real token usage that was never being read anywhere (see cost.ts). Read it
	// once here so every failure path below can still report accurate cost via ModelCallError.
	const usage: ModelUsage = {
		inputTokens: typeof data.usage?.input_tokens === 'number' ? data.usage.input_tokens : 0,
		outputTokens: typeof data.usage?.output_tokens === 'number' ? data.usage.output_tokens : 0,
	};

	const toolUse = data.content?.find((block: any) => block.type === 'tool_use' && block.name === 'submit_answer');
	if (!toolUse) {
		throw new ModelCallError('Model did not return a submit_answer tool call', usage);
	}
	const parsed = agentAnswerSchema.safeParse(toolUse.input);
	if (!parsed.success) {
		// The Anthropic tools API's input_schema is advisory, not enforced on the wire — this
		// is the actual runtime guarantee that a malformed tool call never reaches verifyAnswer(),
		// which assumes `citations` is an array and would otherwise throw on `.filter`.
		throw new ModelCallError(`Model's submit_answer call did not match the expected shape: ${parsed.error.message}`, usage);
	}
	return { answer: parsed.data as AgentAnswer, usage };
}
