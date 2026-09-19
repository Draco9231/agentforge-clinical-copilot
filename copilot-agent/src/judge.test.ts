import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeFaithfulness, filterKnownClaims } from './judge.ts';
import type { AgentAnswer, PatientChart } from './types.ts';

const chart: PatientChart = {
	patientId: '1',
	patientName: 'Test Patient',
	birthDate: null,
	conditions: [],
	medications: [{ text: 'Lisinopril 10mg', status: 'active', authoredOn: '2024-01-02' }],
	recentObservations: [],
};

// Boundary: an answer with zero citations has nothing for a faithfulness pass to add — must
// short-circuit without making a network call (verified here by the absence of an env with a
// working ANTHROPIC_API_KEY; a real call would throw or hang, not return cleanly).
test('judgeFaithfulness: returns immediately with no unfaithful claims when there are no citations', async () => {
	const answer: AgentAnswer = { summary: 'Nothing on file.', citations: [], uncertain_about: [] };
	const result = await judgeFaithfulness({} as any, chart, answer);
	assert.deepEqual(result.unfaithfulClaims, []);
});

// Invariant: a candidate claim that matches one the answer actually made is kept.
test('filterKnownClaims: keeps a candidate that matches an actual citation claim', () => {
	const answer: AgentAnswer = {
		summary: 'x',
		citations: [{ claim: 'Patient is on Lisinopril 10mg', source_field: 'medications[0]' }],
		uncertain_about: [],
	};
	assert.deepEqual(filterKnownClaims(['Patient is on Lisinopril 10mg'], answer), ['Patient is on Lisinopril 10mg']);
});

// Boundary: the judge is asked for exact verbatim text, but an LLM's "exact" isn't guaranteed —
// a paraphrased or hallucinated claim that doesn't match any real citation must be dropped, not
// used to degrade a response over a claim that was never actually made.
test('filterKnownClaims: drops a candidate that does not match any real citation claim', () => {
	const answer: AgentAnswer = {
		summary: 'x',
		citations: [{ claim: 'Patient is on Lisinopril 10mg', source_field: 'medications[0]' }],
		uncertain_about: [],
	};
	assert.deepEqual(filterKnownClaims(['Patient is on a different drug entirely'], answer), []);
});

// Boundary: an empty candidate list must return an empty result, not throw.
test('filterKnownClaims: handles an empty candidate list', () => {
	const answer: AgentAnswer = { summary: 'x', citations: [], uncertain_about: [] };
	assert.deepEqual(filterKnownClaims([], answer), []);
});
