import type { AgentAnswer, Env, PatientChart } from './types';
import { flattenChart } from './verify';
import { judgeResultSchema } from './schemas';

// Addresses ARCHITECTURE.md's known limitation (1): verify.ts's existing check only confirms a
// citation's source_field *exists* in the chart — it does not check that the claim is a faithful
// representation of that field's actual value. A citation pointing at "medications[0]" is
// "verified" by verify.ts even if the claim mischaracterizes what medications[0] actually says
// (wrong dose, wrong frequency, an inference stated as fact). This is that second pass.
//
// Deliberate design choices, stated plainly:
// - One batched call for ALL surviving citations, not one call per citation. The load-tested
//   p50 latency (~9-10s, see EVAL_DATASET.md) is already a documented concern; N sequential judge
//   calls would make that materially worse. Batching keeps this to exactly one extra round-trip
//   regardless of how many citations an answer has.
// - Fails OPEN, not closed: if the judge call itself errors (network, malformed response), the
//   primary verification result from verify.ts is left unchanged rather than the whole request
//   failing. This is an enhancement layered on top of the existence check, not a replacement for
//   it — the existence check (which fails closed, dropping unverifiable citations) remains the
//   safety-critical gate. Logged as its own step either way, so a judge-call failure is visible in
//   agent_logs/Langfuse rather than silently absorbed.
// - Only runs when there's something to judge (citations.length > 0) — an empty-citation answer
//   has nothing for this pass to add.
export interface JudgeResult {
	unfaithfulClaims: string[];
}

const JUDGE_TOOL = {
	name: 'submit_judgment',
	description:
		'For each claim/cited-field pair, judge whether the claim is a faithful representation of ' +
		"what the field actually says — not inferred, not exaggerated, not contradicted. List the " +
		'exact claim text (verbatim) for any claim that is NOT faithful. Faithful claims are not listed.',
	input_schema: {
		type: 'object',
		properties: {
			unfaithfulClaims: {
				type: 'array',
				items: { type: 'string' },
				description: 'Verbatim claim text for each claim that misstates its cited field. Empty if all are faithful.',
			},
		},
		required: ['unfaithfulClaims'],
	},
};

export async function judgeFaithfulness(env: Env, chart: PatientChart, answer: AgentAnswer): Promise<JudgeResult> {
	if (answer.citations.length === 0) {
		return { unfaithfulClaims: [] };
	}

	const fields = flattenChart(chart);
	const pairs = answer.citations
		.map((c, i) => `${i + 1}. Claim: "${c.claim}"\n   Cited field (${c.source_field}): "${fields[c.source_field] ?? '(missing)'}"`)
		.join('\n');

	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': env.ANTHROPIC_API_KEY,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({
			model: 'claude-sonnet-5',
			// Small budget on purpose: this call only ever outputs a list of verbatim strings copied
			// from the input, never new prose — keeping this tight bounds the added latency.
			max_tokens: 1024,
			system:
				'You are a strict clinical fact-checker. For each numbered claim/field pair, decide ' +
				"whether the claim is a faithful, literal representation of the field's value — not a " +
				'reasonable-sounding inference, not a rounded or softened version, not a contradiction. ' +
				'Always respond by calling submit_judgment.',
			messages: [{ role: 'user' as const, content: pairs }],
			tools: [JUDGE_TOOL],
			tool_choice: { type: 'tool', name: 'submit_judgment' },
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new Error(`Judge call failed (${res.status}): ${body}`);
	}

	const data = (await res.json()) as any;
	const toolUse = data.content?.find((b: any) => b.type === 'tool_use' && b.name === 'submit_judgment');
	if (!toolUse) {
		throw new Error('Judge did not return a submit_judgment tool call');
	}

	const parsed = judgeResultSchema.safeParse(toolUse.input);
	if (!parsed.success) {
		throw new Error(`Judge's submit_judgment call did not match the expected shape: ${parsed.error.message}`);
	}

	return { unfaithfulClaims: filterKnownClaims(parsed.data.unfaithfulClaims, answer) };
}

// Pure and separately tested: the judge is asked for exact verbatim claim text, but "exact" from
// an LLM is not guaranteed — only report a claim as unfaithful if it actually matches one this
// answer made, so a paraphrase or hallucinated claim from the judge itself can't silently degrade
// a response over nothing.
export function filterKnownClaims(candidateClaims: string[], answer: AgentAnswer): string[] {
	const knownClaims = new Set(answer.citations.map((c) => c.claim));
	return candidateClaims.filter((c) => knownClaims.has(c));
}
