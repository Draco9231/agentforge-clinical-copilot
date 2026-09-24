# Key Metrics

These are the numbers that would tell a hospital CTO whether the Clinical Co-Pilot is actually
doing its job — not just "is it up," but "is it safe and useful enough that a physician would
keep choosing it over flipping through tabs themselves."

## 1. Verification pass rate (`verified` vs `degraded` vs `blocked`)

**What it is:** the percentage of `/api/chat` responses that come back fully `verified` (every
claim traced to a real chart field) vs. `degraded` (some claim's citation didn't check out) vs.
`blocked` (response withheld entirely).

**Why it's the top metric:** this is a direct, continuously-measured proxy for the single risk
that matters most in this domain — a confidently stated hallucination. Every other metric is
about whether the product is worth using; this one is about whether it's *safe* to use at all.
A hospital CTO's first question would be "how do you know it's not making things up," and this
metric is the honest, always-on answer, not a one-time eval score.

**How we show it's true:** every response the agent produces is verified before it's shown, and
the verification outcome is stored per-message in D1 (`messages.verification_status`) and
per-step in `agent_logs`. Nothing about this metric requires trusting the model's own self-report.

## 2. Source-citation coverage (citations per response, and % of claims backed)

**What it is:** average number of citations per response, and the fraction of the model's
stated claims that survived verification (weren't dropped as pointing at a nonexistent field).

**Why it matters:** "verified" as a binary hides a lot. A response with one shaky citation
dropped out of ten is a very different failure than one where half the claims were fabricated.
This metric is what turns "is it safe" into "how close to the edge is it running."

## 3. End-to-end response latency (p50 / p95)

**What it is:** wall-clock time from `/api/chat` request to response, broken into the three
measured phases (`tool:get_patient_chart`, `llm:call`, `verify`) via `agent_logs.latency_ms`.

**Why it matters:** the entire premise of the product (per the case study) is a 90-second window
between patient rooms. If p95 latency creeps past what a physician will tolerate mid-workflow,
the product fails on its core value proposition regardless of how accurate it is — accuracy and
speed are both non-negotiable, not a tradeoff to pick one side of silently.

## 4. Tool/dependency failure rate

**What it is:** the fraction of requests where `tool:get_patient_chart` or `llm:call` logged
`status: error` in `agent_logs`, broken out by failure type (OpenEMR auth denial vs. OpenEMR
unreachable vs. Anthropic API error).

**Why it matters:** distinguishes "the agent is unsafe" (verification failures) from "the agent
is unreliable" (infrastructure failures) — two different engineering problems with different
fixes. It's also the direct input to the alert thresholds required by the engineering spec.

## 5. Authorization denial rate (401/403 from OpenEMR, surfaced not swallowed)

**What it is:** how often a chat request is denied because the physician's own OpenEMR token
doesn't have access to the requested patient.

**Why it matters:** this is the metric that proves the "no shared elevated credential" design
decision in ARCHITECTURE.md is actually load-bearing and not just documentation. A rate of
exactly zero over time would be suspicious (either nobody's testing access boundaries, or
authorization is silently being bypassed) — this number should be watched, not just minimized.

# Week 2 metrics (multimodal evidence agent)

Week 1's five metrics above still apply unchanged. Week 2 adds document ingestion, retrieval, and
a supervisor graph, each of which introduces a new way to be wrong. These metrics are chosen so
each new failure mode has one number that would expose it. "Measured" states whether the number
exists today.

## 6. Extraction fidelity — factually_consistent, no_invention, quote_grounded (live eval)

**What it is:** on sample documents with a written ground truth (`samples/expected.json`), the
share of expected facts extracted with the right value/flag (recall), whether anything was
extracted that is not in the document (invention), and whether every quoted citation actually
appears in the source text (grounding). Boolean per document, per rubric.

**Why it's the top Week 2 metric:** the PRD's central risk is a vision model that "hallucinates
field labels or overstates confidence." A wrong allergy or medication on an intake form is a
patient-safety failure, and `quote_grounded` is the only check that verifies the model's citation
against the document rather than trusting it.

**Measured:** harness built (`npm run eval:live`); **not yet run** — it needs a real
`ANTHROPIC_API_KEY` in `.dev.vars`, which is a placeholder. No fidelity claim is made until it runs.

## 7. Eval gate health (per-category pass rate vs baseline, and regressions blocked)

**What it is:** pass rate for each rubric category (schema_valid, citation_present,
factually_consistent, safe_refusal, no_phi_in_logs, plus routing_explainable and
retrieval_correct) over the 65-case golden set, compared with `evals/baseline.json`; the push is
blocked if any category is under 95% or regresses more than 5%.

**Why it matters:** it is the difference between a demo and something that can be changed safely.
The number to defend is not "100%" but "a deliberately introduced regression is caught" — shown by
sabotaging the verifier (3 categories failed, 4 cases named, hook exit 1).

**Measured:** yes — 65/65 across 7 categories at the last run. Limit: offline cases exercise the
deterministic layers only, not live model behavior (that is metric 6).

## 8. Citation-contract completeness

**What it is:** the share of clinical claims in a final answer that carry the full
`{source_type, source_id, page_or_section, field_or_chunk_id, quote_or_value}` record, and that the
record resolves to real data (OpenEMR field, uploaded-document fact, or guideline chunk).

**Why it matters:** the PRD requires it on every clinical claim, and it is what makes an answer
auditable by a clinician who wants to see where a statement came from.

**Measured:** enforced structurally (the server derives it, so it is 100% by construction for any
citation that survives verification) and pinned by 5 eval cases. Not yet measured in production:
citations are returned in the response but not persisted, so there is no historical rate.

## 9. Guideline evidence relevance (top rerank score, and share of questions receiving evidence)

**What it is:** for questions routed to `evidence_retriever`, the top reranker score
(`worker:evidence_retriever.topScore` in `agent_logs`) and the fraction that cleared the 0.1
relevance floor and returned evidence.

**Why it matters:** it exposes both corpus gaps (relevant questions returning nothing) and
over-eager retrieval (off-topic questions returning something). Live probing showed on-topic top
scores of 0.30–0.98 and ~0.00004 for an unrelated question, which is why the floor exists.

**Measured:** available from D1 now; only a handful of live questions so far — the distribution
is not yet meaningful.

## 10. PHI-in-logs violations

**What it is:** count of log rows (D1 `agent_logs`, and Langfuse spans) containing a patient
identifier, patient name, or clinical claim text. Target: zero going forward.

**Why it matters:** the PRD makes it a rubric category and names logging raw PHI to SaaS
observability tools as a pitfall. It was a real defect here: before 2026-09-24, 389 of 1,264 log
rows carried a patient identifier and 3 carried claim text. `sanitizeLogDetail` now filters every
detail at the single logging choke point and 7 eval cases pin it.

**Measured:** yes — zero new violations since the fix (newest leaking row predates it). The 392
historical D1 rows and the matching Langfuse spans are **not yet scrubbed**.

## 11. Supervisor routing mix and handoff latency

**What it is:** the share of questions routed to each worker (`supervisor:handoff` rows) and the
time spent in workers versus the model call.

**Why it matters:** routing is a rule, so its failure mode is drift — the evidence worker firing
on plain recall questions (added latency for nothing) or missing real guidance questions. The mix
is the early signal; 8 eval cases pin the individual decisions.

**Measured:** logged per question; not yet analyzed at volume.

## 12. Extraction cost and latency per document

**What it is:** tokens, estimated dollars, and wall-clock per uploaded document (`extract:lab_pdf`
and `extract:intake_form` steps). One realistic one-page, 7-value lab report cost ~$0.018
(~3.8k input / ~1.1k output tokens).

**Why it matters:** extraction cost scales with pages, not questions, so it needs its own line in
the cost model. Latency per document has not been benchmarked; see the cost and latency report.

## Deferred (documented, not measured yet)

- **Time-to-first-useful-answer** from the physician's perspective (requires session/UX
  instrumentation beyond today's shell).
- **Adoption / retention** (would need real physician usage, not applicable to a synthetic-data
  demo).
- **Cost per query** (tokens × price) — tracked in `AI_COST_ANALYSIS.md` and logged per request in
  `agent_logs`; not duplicated here since it's a cost metric, not a success metric.
