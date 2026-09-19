import type { AgentAnswer, Env, PatientChart } from './types';
import { flattenChart } from './verify';
import { agentAnswerSchema } from './schemas';

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
			summary: { type: 'string', description: 'The answer, in plain clinical language, ready to read in a 90-second window.' },
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

export async function askAgent(
	env: Env,
	chart: PatientChart,
	question: string,
	history: ConversationTurn[],
): Promise<AgentAnswer> {
	const fields = flattenChart(chart);
	const chartBlock = Object.entries(fields)
		.map(([key, value]) => `- ${key}: ${value}`)
		.join('\n');

	const system =
		'You are a Clinical Co-Pilot embedded in OpenEMR, helping a physician between patient rooms. ' +
		"You only know what is in the chart data below for THIS patient. Do not use outside medical " +
		"knowledge to state facts about this patient. You may use general clinical knowledge only to " +
		"explain why something might matter, clearly separated from chart facts. Always respond by " +
		"calling submit_answer.\n\nChart data (field_key: value):\n" + chartBlock;

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
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			return await callModel(env, system, messages);
		} catch (e) {
			lastError = e;
		}
	}
	throw lastError;
}

async function callModel(
	env: Env,
	system: string,
	messages: { role: 'user' | 'assistant'; content: string }[],
): Promise<AgentAnswer> {
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
		throw new Error(`Anthropic API error (${res.status}): ${body}`);
	}

	const data = (await res.json()) as any;
	const toolUse = data.content?.find((block: any) => block.type === 'tool_use' && block.name === 'submit_answer');
	if (!toolUse) {
		throw new Error('Model did not return a submit_answer tool call');
	}
	const parsed = agentAnswerSchema.safeParse(toolUse.input);
	if (!parsed.success) {
		// The Anthropic tools API's input_schema is advisory, not enforced on the wire — this
		// is the actual runtime guarantee that a malformed tool call never reaches verifyAnswer(),
		// which assumes `citations` is an array and would otherwise throw on `.filter`.
		throw new Error(`Model's submit_answer call did not match the expected shape: ${parsed.error.message}`);
	}
	return parsed.data as AgentAnswer;
}
