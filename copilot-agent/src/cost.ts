// Found live (2026-09-18) auditing this project against its own requirements: the case study's
// Observability section explicitly requires answering "how many tokens were consumed, and at
// what cost?" from the logs at any time — and this codebase never captured Anthropic's own
// `usage` field from any response, in agent.ts or judge.ts. Every prior cost figure in
// AI_COST_ANALYSIS.md was an estimate; this makes it measurable from real traffic.
//
// Pricing confirmed via Anthropic's published rates as of 2026-09-18: $2 / $10 per million
// input/output tokens for Claude Sonnet 5 — the introductory rate that was kept as standard
// rather than increasing to $3/$15 as originally scheduled for 2026-09-01. A named constant,
// not inlined at each call site, so there's one place to update if pricing changes.
export const CLAUDE_SONNET_5_PRICE_PER_MILLION_INPUT_TOKENS_USD = 2;
export const CLAUDE_SONNET_5_PRICE_PER_MILLION_OUTPUT_TOKENS_USD = 10;

export interface ModelUsage {
	inputTokens: number;
	outputTokens: number;
}

export function estimateCostUsd(usage: ModelUsage): number {
	return (
		(usage.inputTokens / 1_000_000) * CLAUDE_SONNET_5_PRICE_PER_MILLION_INPUT_TOKENS_USD +
		(usage.outputTokens / 1_000_000) * CLAUDE_SONNET_5_PRICE_PER_MILLION_OUTPUT_TOKENS_USD
	);
}

export function sumUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
	return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}
