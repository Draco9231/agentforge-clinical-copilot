# Eval Dataset & Results

Two layers today: (1) pure-function unit tests for the verification logic — runnable right now,
no live dependencies — and (2) HTTP-level boundary tests against the running Worker, which were
run manually this session and are documented here with their actual results. A CI-integrated,
larger eval set (ambiguous queries, unauthorized-patient probing against a *real* OpenEMR
instance, multi-turn context retention) is explicit follow-up work, not silently skipped — see
"Not yet covered" below.

## Layer 1: `src/verify.test.ts` — run with `npm test`

| Test | Category | Guards against |
|---|---|---|
| `verified: citation pointing at a real field survives` | Invariant | Verification being so strict it rejects legitimately-grounded answers (false negative on trust) |
| `degraded: citation pointing at a nonexistent field is dropped, not trusted` | Invariant | The core anti-hallucination guarantee — a fabricated field reference must never be trusted through to the user |
| `boundary: empty patient record does not crash and yields degraded for a claim-free answer` | Boundary (missing data) | Crash or false-positive "verified" on a patient with no chart data at all |
| `boundary: empty-string source_field is treated as missing, not a crash` | Boundary (malformed input) | A malformed/blank citation crashing verification instead of failing safe |
| `regression: flattenChart field-key format stays stable` | Regression | Silent breakage of the field-key naming contract the model is prompted against, which would make every future citation fail to verify without an obvious cause |

**Result at time of writing:** 5/5 passing (`npm test` inside `copilot-agent/`).

## Layer 2: HTTP boundary tests against the running Worker (`wrangler dev`, local)

Run manually this session against `http://localhost:8787` with OpenEMR intentionally not yet
running (real infrastructure-down scenario, not simulated):

| Request | Category | Expected | Actual result |
|---|---|---|---|
| `POST /api/chat` with no `Authorization` header | Boundary / invariant (auth required) | 401, no chart fetch attempted | ✅ `{"error":"missing Authorization", "correlationId": "..."}` — 401 |
| `POST /api/chat` with a bearer token but OpenEMR unreachable | Boundary (dependency down) | 502, clear error, correlation ID, logged | ✅ `{"error":"Could not retrieve patient chart from OpenEMR", "correlationId": "..."}` — logged to `agent_logs` as `tool:get_patient_chart` / `error` with real latency |
| `POST /api/chat` with `{}` body (missing `patientId`/`message`) | Boundary (malformed input) | 400, no downstream calls made | ✅ `{"error":"patientId and message are required", "correlationId": "..."}` |
| `GET /health` | Invariant (liveness) | Always 200 regardless of dependency state | ✅ `{"status":"alive"}` |
| `GET /ready` with OpenEMR down | Invariant (readiness reflects real dependency state, not hardcoded 200) | 503 with per-dependency detail | ✅ `503 {"ready":false,"checks":{"d1":"ok","openemr":"error: ...","anthropic_key_present":"ok"}}` |

Every one of these rows is also a correlation-ID-traceable `agent_logs` row, confirmed by
querying `wrangler d1 execute clinical-copilot-db --local --command "SELECT ... FROM agent_logs"`
after the run.

## Not yet covered (explicit gaps, not oversights)

- **Unauthorized-patient access** against a *real* OpenEMR instance with two distinct user
  accounts of different scopes (needs live OpenEMR — pending Railway deploy).
- **Ambiguous queries** ("what about her levels?" with no antecedent) — needs a live LLM call to
  observe actual model behavior, not just the deterministic verification layer.
- **Ground-truth ("did it actually get the right answer") evaluation**, as opposed to today's
  "did it only claim things it can source" evaluation — these are different questions; today's
  suite only answers the second one.
- **Multi-turn context retention** across several real turns with a live model.
- **Load/concurrency testing** (10 and 50 concurrent users, p50/p95/p99) — requires the live
  deployment; tracked in `AI_COST_ANALYSIS.md` and `ARCHITECTURE.md`'s roadmap.
