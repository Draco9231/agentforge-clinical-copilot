import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateCostUsd, sumUsage } from './cost.ts';

// Invariant: matches Anthropic's published per-million-token rate exactly at round numbers,
// so a mistake in the division (e.g. per-thousand instead of per-million) would be caught.
test('estimateCostUsd: 1 million input tokens costs exactly the input rate', () => {
	assert.equal(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }), 2);
});

test('estimateCostUsd: 1 million output tokens costs exactly the output rate', () => {
	assert.equal(estimateCostUsd({ inputTokens: 0, outputTokens: 1_000_000 }), 10);
});

// Boundary: zero usage (e.g. a failed call before any tokens were reported) must cost exactly
// zero, not NaN or a throw.
test('estimateCostUsd: zero usage costs zero', () => {
	assert.equal(estimateCostUsd({ inputTokens: 0, outputTokens: 0 }), 0);
});

// Regression: a realistic single-query estimate (per AI_COST_ANALYSIS.md's own ballpark of
// ~1,500 input / ~400 output tokens) should land in the low-cent range, not dollars — this is
// the sanity check that would have caught the "not simply cost-per-token" doc actually having a
// unit error if one were introduced.
test('estimateCostUsd: a realistic single query costs a fraction of a cent', () => {
	const cost = estimateCostUsd({ inputTokens: 1500, outputTokens: 400 });
	assert.ok(cost > 0 && cost < 0.01, `expected a small fraction of a cent, got ${cost}`);
});

// Invariant: summing usage across a retried call (agent.ts's bounded single retry) must add
// tokens from both attempts, not overwrite — undercounting cost from a retried request would be
// the exact kind of quiet inaccuracy this feature exists to prevent.
test('sumUsage: adds tokens from both attempts, does not overwrite', () => {
	const first = { inputTokens: 1000, outputTokens: 200 };
	const second = { inputTokens: 1000, outputTokens: 250 };
	assert.deepEqual(sumUsage(first, second), { inputTokens: 2000, outputTokens: 450 });
});
