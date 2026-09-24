import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentGraph } from './graph/graph.ts';

// Regression test for the bug that shipped and failed every /api/chat request: the graph itself
// was never executed by any test, so a LangGraph construction error (a node named `answer`
// colliding with the `answer` state field) only surfaced in production. This runs the real graph
// with fake dependencies — no network, no model.
const chart: any = { patientId: 'p', patientName: 'n', birthDate: null, conditions: [], medications: [], recentObservations: [] };

function deps(over: Partial<Parameters<typeof runAgentGraph>[0]> = {}) {
	const logs: string[] = [];
	return {
		logs,
		d: {
			chart,
			question: 'What should I pay attention to?',
			history: [],
			countDocuments: async () => 2,
			loadDocumentFacts: async () => [{ text: 'A1c: 7.8', source: 's' }],
			retrieveEvidence: async () => ({ evidence: [{ text: 't', source: 'src', section: 'sec', chunkId: 'c1', rerankScore: 0.9 }], note: 'ok' }),
			answer: async () => ({ answer: { summary: 'ok', citations: [], uncertain_about: [] }, usage: { inputTokens: 1, outputTokens: 1 } }),
			log: async (step: string) => { logs.push(step); },
			...over,
		} as Parameters<typeof runAgentGraph>[0],
	};
}

test('graph runs end to end and routes documents -> evidence -> answer', async () => {
	const { d, logs } = deps();
	const r = await runAgentGraph(d);
	assert.equal(r.answer.summary, 'ok');
	assert.deepEqual(r.handoffs.map((h) => h.to), ['intake_extractor', 'evidence_retriever', 'answer']);
	assert.ok(logs.includes('worker:intake_extractor') && logs.includes('worker:evidence_retriever'));
	assert.equal(chart.documentFacts.length, 1);
	assert.equal(chart.guidelineEvidence.length, 1);
});

test('plain recall question with no documents goes straight to the answer', async () => {
	const { d } = deps({ question: 'What meds is he on?', countDocuments: async () => 0 });
	const r = await runAgentGraph(d);
	assert.deepEqual(r.handoffs.map((h) => h.to), ['answer']);
});

test('a model failure propagates instead of being swallowed by the graph', async () => {
	const { d } = deps({ answer: async () => { throw new Error('model down'); } });
	await assert.rejects(runAgentGraph(d), /model down/);
});
