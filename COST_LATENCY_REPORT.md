# Cost and Latency Report (Week 2)

All figures come from the production `agent_logs` table in D1 (`clinical-copilot-db`), queried
2026-09-25 (1,289 rows, 2026-09-17 → 2026-09-25). Nothing here is estimated unless labelled as a
projection. Reproduce with `bash copilot-agent/scripts/demo-observability.sh`.

Pricing: Claude Sonnet 5 at $2 / $10 per million input / output tokens (see AI_COST_ANALYSIS.md).

## 1. Actual dev spend

| What | Logged spend | Notes |
|---|---|---|
| All costed calls in `agent_logs` (2026-09-17 → 09-25) | **$0.36** | Cost fields exist only since 2026-09-18 (`cost.ts`) |
| Of which Week 2 period (from 2026-09-22) | **$0.23** | 4 lab extractions, 2 intake extractions, chat + judge calls |
| Week 1 load tests and eval runs | ~$2–3 | Estimated in AI_COST_ANALYSIS.md from call counts, not from logs |

Not included: Claude Code / IDE usage, Langfuse Cloud, Railway. The live extraction eval
(`npm run eval:live`) has not been run at the time of writing; it adds a few cents.

## 2. Cost per operation (measured)

| Operation | n | Mean input / output tokens | Mean cost |
|---|---|---|---|
| Chat answer (`llm:call`) | 18 | 2,098 / 635 | $0.0105 |
| Faithfulness judge (`verify:judge`) | 15 | 1,557 / 45 | $0.0036 |
| **One chat question (answer + judge)** | | | **≈ $0.014** |
| Lab PDF extraction (`extract:lab_pdf`) | 4 | 3,847 / 1,044 | $0.0181 |
| Intake form extraction (`extract:intake_form`) | 2 | 4,968 / 1,395 | $0.0239 |
| Guideline retrieval (Workers AI embeddings + rerank) | 2 | n/a | no per-call charge at this volume |
| Supervisor routing | 6 | rule-based, no model call | $0 |

Small samples: the extraction figures are 4 and 2 documents. Treat them as an order of magnitude.

## 3. Latency (measured, ms)

| Step | n | p50 | p95 | max |
|---|---|---|---|---|
| `tool:get_patient_chart` (OpenEMR FHIR reads) | 392 | 2,300 | 4,206 | 4,442 |
| `llm:call` (answer model) | 359 | 7,140 | 9,183 | 17,218 |
| `verify:judge` | 17 | 1,159 | 1,558 | 1,894 |
| `worker:evidence_retriever` | 2 | 1,309 | 1,726 | 1,772 |
| `worker:intake_extractor` (D1 read) | 2 | 17 | 17 | 17 |
| `supervisor:handoff` | 6 | ~5 | 19 | 19 |
| `extract:lab_pdf` (upload → structured JSON) | 4 | 7,298 | 7,564 | 7,592 |
| `extract:intake_form` | 2 | 9,966 | 10,203 | 10,229 |
| `upload:openemr_document` | 5 | 647 | 703 | 707 |
| **Chat end to end** (sum of the steps above) | 359 | **9,279** | **12,284** | 21,474 |

The 359 chat samples are mostly the Week 1 load-test window (2026-09-18); the Week 2 chat path
(supervisor + workers) has only a handful of samples. `llm:call` error rate: 33 of 392, of which
31 were on 2026-09-18 (the Week 1 load-test window; cause not broken out here) and 1 on 2026-09-24.

## 4. Bottleneck analysis

1. **The answer model call is the bottleneck: about 77% of p50 chat latency** (7.1 s of 9.3 s). It
   scales with output length, so the two most recent samples (15.4 s and 10.8 s, 1,720 and 1,213
   output tokens) were slow because the answers were long. Commit `521bfde` added a concise-answer
   prompt to attack this directly; **its effect has not been measured yet** (no samples after that
   deploy in the logs).
2. **OpenEMR chart fetch is second: 2.3 s p50.** It is sequential FHIR reads against a small
   Railway container. Parallelising the reads and caching the chart per (user, patient) for a short
   window would cut this without touching the model.
3. **Extraction is model-bound (7–10 s)** because a PDF is sent as a native document. This is a
   one-time cost per upload, not per question, and is acceptable for an upload flow with a spinner.
4. **Week 2 additions are cheap in time.** Supervisor routing is ~5 ms, the extracted-facts read is
   ~17 ms and hybrid retrieval ~1.3 s p50 (0.3–0.75 s when measured in isolation, n=2 in
   production). Retrieval only runs on guidance-type questions.
5. **The judge adds ~1.2 s and ~$0.004** whenever a response carries citations.

Ranked levers: measure the concise prompt; parallelise chart reads; stream the answer so the
physician reads while it finishes; prompt-cache the system prompt and chart block (the judge
re-sends most of the same context); sample the judge instead of running it on every answer.

## 5. Projected production cost

Assumptions: 5 questions per user per clinic day, 1 document upload per user per clinic day
(blended $0.021), 22 clinic days per month. Per user: 110 questions × $0.0141 = $1.55, plus
22 uploads × $0.021 = $0.46, so **about $2.0 per user per month** in model cost.

| Users | Model cost / month | What changes besides model cost |
|---|---|---|
| 100 | ~$201 | Nothing; current architecture holds |
| 1,000 | ~$2,010 | OpenEMR container and DB tier bump; Langfuse paid tier |
| 10,000 | ~$20,100 | Prompt caching becomes cost-material; move logs off D1; multiple OpenEMR instances |
| 100,000 | ~$201,000 | Multi-tenant OpenEMR fleet; sample the judge; document storage moves from D1 to R2 |

This assumes the current answer length. If the concise-answer prompt cuts output tokens by a third
(unverified), the answer call drops from $0.0105 to roughly $0.0075. Storage: the source PDF is
kept in D1 (capped at 1.8 MB per file), which is fine to the low thousands of documents; R2 is the
next step.

## 6. Still to measure

- Chat latency and cost after the concise-prompt change, on the Week 2 path (needs an authenticated
  run: `BASE_URL=... OPENEMR_ADMIN_PASSWORD=... PATIENT_ID=... node copilot-agent/scripts/load-test.mjs 10`).
- Live extraction accuracy and cost across the sample documents (`npm run eval:live`).
- p95 under 50 concurrent users for the Week 2 path.
