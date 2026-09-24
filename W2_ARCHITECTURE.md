# Week 2 Architecture — Multimodal Evidence Agent

Extends the Week 1 Clinical Co-Pilot (see [ARCHITECTURE.md](./ARCHITECTURE.md)) with document
ingestion, a supervisor + worker graph, and an eval-gated push. Everything here runs in the same
Cloudflare Worker + D1 as Week 1; OpenEMR (Railway) remains the system of record for patient data.

## Status at a glance (honest)

| Capability | State |
|---|---|
| Lab PDF ingestion + strict-schema extraction with per-fact citations | **Built, live-verified** |
| Intake form ingestion (demographics, chief concern, meds, allergies, family history) | **Built, deployed; live extraction not yet run** |
| Source PDF stored in OpenEMR | **Built, best-effort** (F-2: cannot be read back; category unverifiable) |
| Supervisor + `intake_extractor` + `evidence_retriever` (LangGraph.js) | **Built** |
| Hybrid RAG (FTS5 + embeddings, RRF, reranker) over a 14-chunk guideline corpus | **Built; retrieval verified live, end-to-end chat not yet observed** |
| Unified citation contract on every cited claim in the answer | **Built** |
| Eval gate: 65 cases, 7 categories, boolean rubrics, pre-push hook | **Built, sabotage-tested** |
| Live-model eval tier (extraction vs ground truth, quote grounding) | **Built; not yet run** (needs a real API key in `.dev.vars`) |
| Visual PDF bounding-box / click-to-source UI | **Not built** |
| Writing intake medications/allergies back into OpenEMR records | **Not built** (deliberate; see Risks) |

## Summary

A physician uploads a scanned lab PDF or patient intake form for the selected patient. The Worker sends it to Claude
Sonnet 5 as a native PDF document and forces a `submit_lab_extraction` tool call, whose output is
validated against a strict Zod schema (for labs: test name, value, unit, reference range,
collection date, abnormal flag; for intake: demographics, chief concern, medications, allergies,
family history; plus extraction confidence and a citation on every item). The structured facts are stored
in D1 (`documents`, `document_facts`) and the source PDF is written to OpenEMR. When the
physician later asks a question, a rule-based supervisor decides which workers are needed:
`intake_extractor` loads the patient's extracted document facts into the same chart the model
reads and the verifier checks, so they are citable and verified exactly like OpenEMR data;
`evidence_retriever` runs hybrid retrieval (keyword + embedding candidates, rank fusion, reranker)
over a small guideline corpus. Every handoff is logged with a reason. A 65-case offline eval runs
on every `git push` and blocks it if any rubric category falls below 95% or regresses more than 5%
from baseline; a separate live-model tier checks extraction against ground truth.

Key decisions: (1) D1, not OpenEMR, is the source of truth for document identity and citations,
because OpenEMR's document read path is unusable in this fork (F-2). (2) The supervisor is rules,
not an LLM, to avoid an extra model round trip on a latency-bound path and to keep routing
inspectable. (3) OpenEMR authorization is enforced *before* the graph runs, so a restricted user
never reaches document facts. (4) The eval gate is offline and deterministic so it can run on
every push for free; the price is that it does not exercise the live model (see Risks).

## Document ingestion flow

`POST /api/documents/attach_and_extract` (multipart: `patientId`, `doc_type=lab_pdf|intake_form`, `file`)

1. Auth: Bearer token required (the physician's own OpenEMR token, same as Week 1).
2. A document id (UUID) is minted **first**; it becomes every citation's `source_id`.
3. `extraction.ts` calls Claude Sonnet 5 with the PDF as a base64 `document` block and a forced
   `submit_lab_extraction` or `submit_intake_extraction` tool (one shared helper). The model supplies `page_or_section`, `field_or_chunk_id` and
   `quote_or_value` per result; the **server** attaches `source_type` and `source_id` (the model
   cannot know our internal id and is never asked to invent it).
4. The tool output is validated by `labPdfExtractionSchema` or `intakeFormExtractionSchema`
   (`schemas.ts`). Citation fields are
   `min(1)`; `abnormal_flag` is a closed enum; `extraction_confidence` is required so a shaky scan
   is visibly flagged. A malformed call becomes a logged 502, not a crash.
5. Best-effort OpenEMR write: resolve the FHIR UUID to OpenEMR's numeric `pid`, then
   `POST /api/patient/:pid/document` (standard API; category `labreports` for labs,
   `patientinformation` for intake forms — both are guesses, see F-2). Failure never blocks the
   response.
6. Persist to D1: one `documents` row, one `document_facts` row per extracted fact (each lab
   result; each intake demographic, chief concern, medication, allergy, family-history item)
   holding the citation contract exactly as produced.
7. Response: `{documentId, doc_type, openemrUploadOk, ...extraction}` (`results[]` for labs;
   `demographics`, `chief_concern`, `current_medications`, `allergies`, `family_history` for intake).

Intake-specific choices: facts reach the answer model labelled *patient-reported … (intake form)*
so an intake medication is never presented as a chart medication (the mismatch between the two is
exactly what a physician wants surfaced). Phone, address and email are stored but **never put in
the prompt** — data minimization at the model boundary, pinned by an eval case.

Measured on a realistic one-page, 7-value lab report: all 7 values, units, ranges, flags and page
citations extracted correctly, high confidence, ~3.8k input / ~1.1k output tokens (~$0.018).
Latency for extraction has **not** been benchmarked yet.

## Worker graph

```
START → supervisor ─┬→ intake_extractor ─┐
                    ├→ evidence_retriever ┼→ supervisor → … → answer → END
                    └→ answer → END      ─┘
```

- **Supervisor** (`graph/routing.ts`, pure function `decideNext`): if the patient has uploaded
  documents and they have not been loaded → `intake_extractor`; else if the question asks for
  guidance or what to act on (regex over words like *should, guideline, target, risk, pay
  attention, what changed*) and evidence has not been fetched → `evidence_retriever`; else →
  `answer`. It returns a human-readable reason with every decision.
- **intake_extractor**: loads the patient's `document_facts` (newest first, deduped by
  test+date so re-uploads don't multiply facts) and attaches them to the chart as
  `documentFacts[n]`.
- **evidence_retriever**: runs the hybrid retrieval described below and attaches the top chunks to
  the chart as `guidelineEvidence[n]`; logs hit count, top rerank score and candidate counts only.
- **answer**: the Week 1 `askAgent` call, unchanged, then Week 1 verification and the faithfulness
  judge run as before.
- LangGraph.js was verified to bundle and run under workerd using the `@langchain/langgraph/web`
  entry point with the Worker's existing `nodejs_compat` flag. State is per-request and
  in-memory; no checkpointer (so none of the Postgres/Hyperdrive machinery).
- Handoffs are logged as `supervisor:handoff` (from, to, reason, document count), returned in the
  `/api/chat` response, and shown in the UI. Reasons are fixed templates plus a count — never
  question or chart text.
- Routing is covered by 8 eval cases, including one asserting a reason never echoes question text.

Why the chart fetch is outside the graph: OpenEMR's authorization must surface as a real HTTP
403, which is awkward to unwind from inside graph execution. It also guarantees the D1 document
lookup cannot run for a user OpenEMR has already denied.

## RAG design (built)

Corpus: `corpus/guidelines.json`, 14 short **paraphrased** excerpts of ADA and ACC/AHA guidance on
diabetes, lipids and hypertension (matching the demo patients), each with source and section. They
are demo material — not verbatim quotations and not clinically reviewed — and the file says so.

Pipeline (`src/rag.ts`):
1. **Query** = the question plus the patient's condition names, so a generic "what should I pay
   attention to?" still retrieves diabetes/lipid guidance (a contextual-retrieval improvement).
2. **Sparse**: D1 FTS5, BM25-ordered, over a sanitized OR-query (stopwords and FTS syntax stripped).
3. **Dense**: `@cf/baai/bge-base-en-v1.5` embeddings (`cls` pooling for chunks and queries),
   cached in D1 on first use, cosine computed in the Worker. At 14 chunks a vector database
   (Vectorize) would be overkill; it becomes the right tool at orders of magnitude more chunks.
4. **Fusion**: reciprocal rank fusion, chosen because BM25 and cosine scores are on incomparable
   scales.
5. **Rerank**: `@cf/baai/bge-reranker-base` over the fused candidates (top 8 → top 3).
6. **Relevance floor 0.1**. Measured live on four queries: on-topic top hits scored 0.30–0.98, weak
   secondary matches ~0.04–0.06, and an unrelated query ~0.00004 on every chunk. Below the floor,
   the question gets *no* guideline evidence rather than the three least-bad chunks.

Guideline text enters the prompt as `guidelineEvidence[n]`, marked in the field text and the system
prompt as general guidance, never a fact about the patient, and each retrieved chunk carries
`{source_type:'guideline', source_id: chunk id, page_or_section: source - section, quote_or_value}`.
Measured retrieval latency: ~0.3–0.75 s. No new vendor account or key (Workers AI binding).

Failure behavior: if retrieval throws, the question is answered without guideline evidence and the
failure is logged — retrieval is additive and never fails a physician's question.

## Citation contract on answers

The model only ever names a `source_field` (e.g. `documentFacts[0]`). `citations.ts` derives the
full `{source_type, source_id, page_or_section, field_or_chunk_id, quote_or_value}` record
server-side for every citation that survived verification — from the stored extraction citation
(uploaded documents), the retrieved chunk (guidelines), or the flattened FHIR field (OpenEMR data).
The model never authors provenance. It is added to the `/api/chat` response additively, so the
Week 1 `{claim, source_field}` shape the UI reads is unchanged. Not yet built: rendering it as a
click-to-source panel or a PDF bounding-box overlay.

## Eval gate

**Offline gate (every push).**
- `evals/golden.json`: 65 deterministic cases (target was 50), each naming the failure mode it
  guards. Categories: `schema_valid` (12), `citation_present` (13), `factually_consistent` (10),
  `safe_refusal` (6), `no_phi_in_logs` (7), `routing_explainable` (8), `retrieval_correct` (9).
- `evals/run-evals.ts` runs them against the real `src/` modules — no network, no model calls
  (~1 s). Boolean pass/fail only. Fails the build if any category is below 95%, regresses more than
  5% from `evals/baseline.json`, or a case throws.
- `.githooks/pre-push` runs `npm test` then `npm run eval`. Install once per clone with
  `npm run hooks:install`.
- **Evidence it blocks:** replacing the verifier's citation-existence check with `true` failed
  three categories, named four cases, and the hook exited 1; restoring the file returned exit 0.
  The hook has run on every real push since.
- The suite found real defects while being written: blank citation fields passed validation, and
  logs contained PHI (F-3). Both are fixed and guarded.

**Live-model tier (on demand).** `evals/live-extraction.ts` (`npm run eval:live`) runs real
extraction on `samples/*.pdf` against `samples/expected.json` and grades five boolean rubrics per
document: `schema_valid`, `citation_present`, `factually_consistent` (expected facts present with
right values/flags), `no_invention` (nothing extracted that is not in the truth set — a fabricated
medication or allergy), and `quote_grounded` (every quoted citation appears in the source text).
It costs a few cents and needs a real API key. **It has not been run**: the local `.dev.vars` key
is a placeholder, so no extraction-accuracy claim is made in this document.

## Findings (this project's audit habit, applied to Week 2)

- **F-1 — OpenEMR OAuth clients are immutable in scope and the admin UI cannot edit them.** A
  client only ever receives the scopes it was registered with (extra requested scopes are dropped
  silently — the token endpoint returns 200). The admin "Client Registrations" page only lists,
  enables and disables. Adding `user/document.crs`, `user/patient.crus`, `user/allergy.cruds`,
  `user/medication.cruds` required registering a new client and switching to it.
- **F-1b — Dynamic client registration is open.** `POST /oauth2/default/registration` accepted an
  unauthenticated request and created a client. It was unusable until an admin enabled it, which
  is what limited the impact — but it should be restricted or monitored. Three clients are now
  enabled (Week 1, an intermediate one, and the current one); the unused two should be disabled.
- **F-2 — OpenEMR's document API cannot be used as a system of record.** Traced in
  `src/Services/DocumentService.php`: FHIR exposes no `Observation` create and `DocumentReference`
  only has the `$docref` (CCD generation) operation, so the standard API is the only upload path.
  It takes the numeric `pid`, not the FHIR UUID; returns `true` with no document id; `isValidPath()`
  `unset()`s index 0 of a single-segment path, emptying the loop that would validate it, so it
  always passes; `getLastIdOfPath()` compares the raw input against a lowercased, space-stripped
  column, so multi-word or mixed-case category names never match. Result: uploads report success,
  list-by-category returns an empty array that `RestControllerHelper` reports as a 404, and
  per-id fetch returned 500. Mitigation: mint our own document id, keep D1 as the source of truth,
  write to OpenEMR best-effort. **The category name is a guess:** because validation is a no-op and
  listing is broken, there is no way to confirm that `labreports` (or `patientinformation` for
  intake forms) matches a real OpenEMR category; the upload returns success either way, and the
  document may be stored uncategorized. This should be checked in OpenEMR's own Documents UI.
- **F-3 — PHI in logs.** `logStep` was sending the patient identifier
  (`tool:get_patient_chart`) and the free text of dropped clinical claims (`verify`) to D1 and to
  Langfuse. Fixed at the choke point with `sanitizeLogDetail` (`logging.ts`): key deny-list applied
  recursively, claim lists reduced to counts, root strings truncated.
- **F-4 — Week 1 client-side timestamps.** Live messages had no timestamp and rendered under the
  previous day's divider; fixed.
- **F-5 — Historical PHI already in logs.** Querying D1 on 2026-09-24: 389 of 1,264 `agent_logs`
  rows contain a patient identifier and 3 contain clinical-claim text, all written before the F-3
  fix (the newest leaking row predates it). Nothing new leaks, but the historical D1 rows and the
  corresponding Langfuse spans are **not scrubbed**; that is an open remediation item.

## Observability (Week 2 additions)

Same correlation-ID pattern as Week 1. New steps: `extract:lab_pdf` and `extract:intake_form`
(fact count, extraction confidence, tokens, estimated cost), `upload:openemr_document`,
`persist:document`, `supervisor:handoff` (from, to, reason, document count),
`worker:intake_extractor` (fact count), and `worker:evidence_retriever` (hit count, top rerank
score, sparse/dense/candidate counts). All details pass through `sanitizeLogDetail` before reaching
D1, console, or Langfuse; queries, retrieved text, quotes and file names are never logged.
Not yet done: extraction confidence and per-encounter cost rolled into a dashboard summary, and
p50/p95 latency for the Week 2 steps (see the cost and latency report, still to be written).

## Risks and tradeoffs

1. **Extraction citations are not machine-verified against the PDF.** The page and quote come from
   the model's own tool output. `citations: {enabled: true}` is set on the document block, but
   nothing in our code reads Anthropic's citation blocks (the extraction is taken from the forced
   tool call's input), so nothing checks that a quoted string actually appears on the cited page.
   Whether native citations could be combined with a forced tool call has not been tested. This is the "vision extraction without
   invention" risk the PRD names. The live eval tier's `quote_grounded` rubric now checks this
   offline against ground truth, but it is **not enforced at runtime**: an ungrounded quote in a
   real upload is not flagged. Planned: runtime substring check against the PDF text layer, and
   bounding boxes for the visual overlay.
2. **The push gate is offline.** It proves the deterministic layers (schemas, verification, log
   redaction, routing, retrieval math, dedupe) cannot regress silently. It does not measure live
   extraction accuracy or answer quality; a bad prompt change would not fail it. The on-demand live
   tier addresses this but has not been run, and is not wired into the hook (cost, network).
3. **The hook is local.** It is not versioned into `.git/hooks`, must be installed per clone, and
   can be bypassed with `--no-verify`. No server-side GitLab CI job is configured, so it is not
   enforced at merge.
4. **Rule-based routing is brittle to phrasing.** The evidence regex will miss a guidance
   question worded unusually and over-trigger on some recall questions. The cost of a miss is a
   less-grounded answer, not an unsafe one; the routing eval cases are the guard as it evolves.
5. **`sanitizeLogDetail` is a deny-list.** It cannot catch PHI inside an arbitrary string value
   (e.g. an upstream error message); root strings are truncated to 200 characters as a bound, not
   a guarantee.
6. **D1 as source of truth splits records** from OpenEMR: a physician sees the PDF in OpenEMR, but
   extracted facts exist only in this app's database, outside OpenEMR's ACL model. Access is
   gated indirectly by requiring a successful OpenEMR chart read first.
7. **Latency.** Chat is still bound by the model call (p50 ~9-10 s in Week 1). Supervisor and
   worker overhead is small (two D1 reads), but no new latency benchmark has been run for Week 2.
8. **Intake data is not written back to OpenEMR records.** The scopes for allergy/medication writes
   were registered, but creating chart records from a patient-completed form needs an idempotency
   and clinician-review design (the PRD's "no duplicate or untraceable records"); auto-writing a
   patient-reported allergy or medication into the legal chart would be worse than not writing it.
   Facts live in D1 and reach the physician through the agent, labelled patient-reported.
9. **Guideline corpus provenance.** The excerpts are paraphrases written for the demo. A real
   deployment must index the actual guideline text with versioning and review; retrieval quality
   numbers here say nothing about guideline correctness.
10. **Guideline advice vs. patient facts.** The model is told to keep them apart and each retrieved
    chunk is verified as a citable field, but the faithfulness judge does not separately check that
    a guideline was not presented as a patient fact; this is a prompt-level control plus review.
