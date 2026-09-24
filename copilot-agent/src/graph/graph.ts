import { Annotation, StateGraph, START, END } from '@langchain/langgraph/web';
import type { AgentAnswer, PatientChart } from '../types';
import type { ModelUsage } from '../cost';
import { decideNext, type Handoff, type Worker } from './routing';

// One supervisor, two workers, one answer step (W2 PRD Stage 3). LangGraph.js runs inside the
// Worker's own isolate — verified under workerd (2026-09-24) with the `/web` entry point and the
// nodejs_compat flag already set for the Worker. State is per-request and in-memory: each
// question is one self-contained run, so no checkpointer (and none of the Postgres/Hyperdrive
// machinery that would need) is used.
//
// The OpenEMR chart fetch deliberately happens *before* this graph, in index.ts: it enforces the
// user's own OpenEMR authorization and must surface as a real 403, which would be awkward to
// unwind from inside graph execution. The chart object is therefore passed in and mutated by the
// intake_extractor worker (documentFacts) rather than round-tripped through graph state.

export interface GraphDeps {
	chart: PatientChart;
	question: string;
	history: { role: 'user' | 'assistant'; content: string }[];
	countDocuments: () => Promise<number>;
	loadDocumentFacts: () => Promise<NonNullable<PatientChart['documentFacts']>>;
	retrieveEvidence: (question: string) => Promise<{ evidence: { text: string; source: string; section: string; chunkId: string; rerankScore?: number }[]; note: string; stats?: Record<string, unknown> }>;
	answer: (chart: PatientChart, question: string, history: { role: 'user' | 'assistant'; content: string }[]) => Promise<{ answer: AgentAnswer; usage: ModelUsage }>;
	// Structured, PHI-free step logging (see logging.ts). Called for every handoff and worker run.
	log: (step: string, status: 'ok' | 'error', latencyMs: number, detail?: unknown) => Promise<void>;
}

const State = Annotation.Root({
	documentCount: Annotation<number | undefined>(),
	docsDone: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
	evidenceDone: Annotation<boolean>({ reducer: (_a, b) => b, default: () => false }),
	next: Annotation<Worker | 'supervisor'>({ reducer: (_a, b) => b, default: () => 'supervisor' }),
	handoffs: Annotation<Handoff[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
	answer: Annotation<AgentAnswer | undefined>(),
	usage: Annotation<ModelUsage | undefined>(),
});

export interface GraphResult {
	answer: AgentAnswer;
	usage: ModelUsage;
	handoffs: Handoff[];
}

export async function runAgentGraph(deps: GraphDeps): Promise<GraphResult> {
	const graph = new StateGraph(State)
		.addNode('supervisor', async (state) => {
			const start = Date.now();
			const documentCount = state.documentCount ?? (await deps.countDocuments());
			const decision = decideNext({ question: deps.question, documentCount, docsDone: state.docsDone, evidenceDone: state.evidenceDone });
			const handoff: Handoff = { from: 'supervisor', to: decision.next, reason: decision.reason, at: new Date().toISOString() };
			// The reason strings are fixed templates plus a count — no question text, no chart
			// content — so logging them verbatim stays inside the no-PHI-in-logs rule.
			await deps.log('supervisor:handoff', 'ok', Date.now() - start, { from: handoff.from, to: handoff.to, reason: handoff.reason, documentCount });
			return { documentCount, next: decision.next, handoffs: [handoff] };
		})
		.addNode('intake_extractor', async () => {
			const start = Date.now();
			const facts = await deps.loadDocumentFacts();
			deps.chart.documentFacts = facts;
			await deps.log('worker:intake_extractor', 'ok', Date.now() - start, { factCount: facts.length });
			return { docsDone: true };
		})
		.addNode('evidence_retriever', async () => {
			const start = Date.now();
			const result = await deps.retrieveEvidence(deps.question);
			deps.chart.guidelineEvidence = result.evidence.map((e) => ({ text: e.text, source: e.source, section: e.section, chunkId: e.chunkId }));
			// Scores and counts only — never the query or the retrieved text (query carries the
			// physician's question and the patient's conditions).
			await deps.log('worker:evidence_retriever', 'ok', Date.now() - start, {
				retrievalHits: result.evidence.length,
				topScore: result.evidence[0]?.rerankScore ?? null,
				note: result.note,
				...(result.stats ?? {}),
			});
			return { evidenceDone: true };
		})
		// Node is named compose_answer, not answer: LangGraph rejects a node whose name matches a
		// state field (here `answer`), which threw on every request before this was caught. The
		// supervisor's routing vocabulary (and the logged handoff `to`) stays 'answer'.
		.addNode('compose_answer', async () => {
			const result = await deps.answer(deps.chart, deps.question, deps.history);
			return { answer: result.answer, usage: result.usage };
		})
		.addEdge(START, 'supervisor')
		.addConditionalEdges('supervisor', (state) => state.next as Worker, {
			intake_extractor: 'intake_extractor',
			evidence_retriever: 'evidence_retriever',
			answer: 'compose_answer',
		})
		.addEdge('intake_extractor', 'supervisor')
		.addEdge('evidence_retriever', 'supervisor')
		.addEdge('compose_answer', END)
		.compile();

	const final = await graph.invoke({});
	if (!final.answer || !final.usage) throw new Error('graph finished without producing an answer');
	return { answer: final.answer, usage: final.usage, handoffs: final.handoffs };
}
