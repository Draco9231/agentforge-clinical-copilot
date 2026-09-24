# Week 2 Architecture — Multimodal Evidence Agent

Extends the Week 1 Clinical Co-Pilot (see [ARCHITECTURE.md](./ARCHITECTURE.md)) with document
ingestion, a supervisor + worker graph, and an eval-gated push. Everything here runs in the same
Cloudflare Worker + D1 as Week 1; OpenEMR (Railway) remains the system of record for patient data.

## Status at a glance (honest)

| Capability | State |
|---|---|
| Lab PDF ingestion + strict-schema extraction with per-fact citations | **Built, live-verified** |
| Source PDF stored in OpenEMR | **Built, best-effort** (see finding F-2: cannot be read back) |
| Supervisor + `intake_extractor` + `evidence_retriever` (LangGraph.js) | **Built**; evidence worker is a **zero-hit stub** |
| Hybrid RAG + rerank over a guideline corpus | **Designed, not built** (Part 2) |
| Intake form ingestion | **Not built** (Part 2); endpoint refuses it explicitly |
| Eval gate: 40 of 50 cases, boolean rubrics, pre-push hook | **Built, sabotage-tested** |
| Visual PDF bounding-box / click-to-source UI | **Not built** (Part 2) |
| Live-model eval (extraction accuracy against ground truth) | **Not built** (Part 2) |

## Summary

A physician uploads a scanned lab PDF for the selected patient. The Worker sends it to Claude
Sonnet 5 as a native PDF document and forces a `submit_lab_extraction` tool call, whose output is
validated against a strict Zod schema (test name, value, unit, reference range, collection date,
abnormal flag, extraction confidence, and a citation per result). The structured facts are stored
in D1 (`documents`, `document_facts`) and the source PDF is written to OpenEMR. When the
physician later asks a question, a rule-based supervisor decides which workers are needed:
`intake_extractor` loads the patient's extracted document facts into the same chart the model
reads and the verifier checks, so they are citable and verified exactly like OpenEMR data;
`evidence_retriever` is where guideline evidence will be retrieved. Every handoff is logged with a
reason. A 40-case offline eval runs on every `git push` and blocks it if any rubric category
falls below 95% or regresses more than 5% from baseline.

Key decisions: (1) D1, not OpenEMR, is the source of truth for document identity and citations,
because OpenEMR's document read path is unusable in this fork (F-2). (2) The supervisor is rules,
not an LLM, to avoid an extra model round trip on a latency-bound path and to keep routing
inspectable. (3) OpenEMR authorization is enforced *before* the graph runs, so a restricted user
never reaches document facts. (4) The eval gate is offline and deterministic so it can run on
every push for free; the price is that it does not exercise the live model (see Risks).

## Document ingestion flow

`POST /api/documents/attach_and_extract` (multipart: `patientId`, `doc_type=lab_pdf`, `file`)

1. Auth: Bearer token required (the physician's own OpenEMR token, same as Week 1).
2. A document id (UUID) is minted **first**; it becomes every citation's `source_id`.
3. `extraction.ts` calls Claude Sonnet 5 with the PDF as a base64 `document` block and a forced
   `submit_lab_extraction` tool. The model supplies `page_or_section`, `field_or_chunk_id` and
   `quote_or_value` per result; the **server** attaches `source_type` and `source_id` (the model
   cannot know our internal id and is never asked to invent it).
4. The tool output is validated by `labPdfExtractionSchema` (`schemas.ts`). Citation fields are
   `min(1)`; `abnormal_flag` is a closed enum; `extraction_confidence` is required so a shaky scan
   is visibly flagged. A malformed call becomes a logged 502, not a crash.
5. Best-effort OpenEMR write: resolve the FHIR UUID to OpenEMR's numeric `pid`, then
   `POST /api/patient/:pid/document` (standard API). Failure never blocks the response.
6. Persist to D1: one `documents` row, one `document_facts` row per result holding the citation
   contract exactly as produced.
7. Response: `{documentId, openemrUploadOk, results[], extraction_confidence, unparsed_notes}`.

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
- **evidence_retriever**: currently returns zero snippets and logs `retrievalHits: 0`.
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

## RAG design (planned — not built)

Small guideline corpus (diabetes / lipid / hypertension excerpts matching the demo patients).
Sparse retrieval via D1 FTS5, dense retrieval via Cloudflare Vectorize with Workers AI
embeddings, candidates merged, then reranked with Workers AI `@cf/baai/bge-reranker-base`
(`env.AI.run(model, {query, contexts:[{text}]})`, 512-token passages; no new vendor account).
Only the top reranked chunks are passed to the answer model, in a section clearly labeled as
guideline evidence and separate from patient-record facts, each with `{source_type:'guideline',
source_id, page_or_section, field_or_chunk_id, quote_or_value}`. The `evidence_retriever` seam and
its logged `retrievalHits` field already exist; only the retrieval body is missing.

## Eval gate

- `evals/golden.json`: 40 deterministic cases (target 50). Each names the failure mode it guards.
  Categories: `schema_valid` (8), `citation_present` (6), `factually_consistent` (7),
  `safe_refusal` (5), `no_phi_in_logs` (6), plus `routing_explainable` (8).
- `evals/run-evals.ts` runs them against the real `src/` modules — no network, no model calls
  (~1 s). Boolean pass/fail only. Fails the build if any category is below 95%, regresses more than
  5% from `evals/baseline.json`, or a case throws.
- `.githooks/pre-push` runs `npm test` then `npm run eval`. Install once per clone with
  `npm run hooks:install`.
- **Evidence it blocks:** replacing the verifier's citation-existence check with `true` failed
  three categories, named four cases (C3, F3, F4, R2), and the hook exited 1; restoring the file
  returned exit 0. The hook has also run on real pushes.
- The suite found two real defects while being written: blank citation fields passed validation,
  and logs contained PHI (below). Both are fixed and now guarded.

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
  write to OpenEMR best-effort with the lowercase, space-free category `labreports`.
- **F-3 — PHI in logs.** `logStep` was sending the patient identifier
  (`tool:get_patient_chart`) and the free text of dropped clinical claims (`verify`) to D1 and to
  Langfuse. Fixed at the choke point with `sanitizeLogDetail` (`logging.ts`): key deny-list applied
  recursively, claim lists reduced to counts, root strings truncated.
- **F-4 — Week 1 client-side timestamps.** Live messages had no timestamp and rendered under the
  previous day's divider; fixed.

## Observability (Week 2 additions)

Same correlation-ID pattern as Week 1. New steps: `extract:lab_pdf` (result count, extraction
confidence, tokens, cost), `upload:openemr_document`, `persist:document`, `supervisor:handoff`,
`worker:intake_extractor` (fact count), `worker:evidence_retriever` (retrieval hits). All details
pass through `sanitizeLogDetail` before reaching D1, console, or Langfuse. Not yet done:
extraction confidence and per-encounter cost rolled into the dashboard summary.

## Risks and tradeoffs

1. **Extraction citations are not machine-verified against the PDF.** The page and quote come from
   the model's own tool output. `citations: {enabled: true}` is set on the document block, but
   nothing in our code reads Anthropic's citation blocks (the extraction is taken from the forced
   tool call's input), so nothing checks that a quoted string actually appears on the cited page.
   Whether native citations could be combined with a forced tool call has not been tested. This is the "vision extraction without
   invention" risk the PRD names. Planned: substring-check each quote against the PDF's text layer
   and flag unmatched results; bounding boxes for the visual overlay.
2. **The eval gate is offline.** It proves the deterministic layers (schemas, verification, log
   redaction, routing, dedupe) cannot regress silently. It does not measure live extraction
   accuracy or answer quality; a bad prompt change would not fail it. Planned: a live-model tier
   with ground-truth documents, run on demand and before release.
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
