// The supervisor's routing policy as a pure function, deliberately separate from the LangGraph
// wiring (graph.ts) so it can be unit-tested and covered by the eval gate without a model or a
// network. Rule-based rather than an LLM call: a routing decision that costs an extra model
// round trip on every question would add seconds to an already latency-bound path (p50 ~9-10s,
// see EVAL_DATASET.md), and a written rule is inspectable in a way a sampled decision is not —
// the W2 PRD's "make the supervisor's routing decisions inspectable". Every decision returns a
// human-readable reason that gets logged as a handoff.

export type Worker = 'intake_extractor' | 'evidence_retriever' | 'answer';

export interface RoutingState {
	question: string;
	// undefined until the supervisor has looked; the first visit fetches it.
	documentCount: number | undefined;
	docsDone: boolean;
	evidenceDone: boolean;
}

export interface Decision {
	next: Worker;
	reason: string;
}

export interface Handoff {
	from: string;
	to: string;
	reason: string;
	at: string;
}

// Questions that ask for guidance, thresholds, or what to act on need guideline evidence, not
// just chart facts. Plain recall questions ("what meds is he on?") do not, and routing them
// through retrieval would add latency and irrelevant context for no benefit.
const EVIDENCE_PATTERN =
	/\b(guideline|guidelines|recommend|recommendation|should|target|goal|risk|screen|screening|treat|treatment|manage|management|pay attention|next step|what changed|evidence|standard of care)\b/i;

export function needsEvidence(question: string): boolean {
	return EVIDENCE_PATTERN.test(question);
}

export function decideNext(s: RoutingState): Decision {
	if (!s.docsDone) {
		if ((s.documentCount ?? 0) > 0) {
			return { next: 'intake_extractor', reason: `patient has ${s.documentCount} uploaded document(s); loading their extracted facts` };
		}
	}
	if (!s.evidenceDone && needsEvidence(s.question)) {
		return { next: 'evidence_retriever', reason: 'question asks for guidance or what to act on; retrieving guideline evidence' };
	}
	return { next: 'answer', reason: 'context sufficient; producing the final answer' };
}
