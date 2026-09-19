# Eval Dataset & Results

Three layers: (1) pure-function unit tests for the verification/schema logic — runnable right
now, no live dependencies; (2) HTTP-level boundary tests against the running Worker; and (3)
live-deployment tests (ambiguous queries, multi-turn retention, load tests at 10/50 concurrent)
run against the actual production Worker + OpenEMR on Railway on 2026-09-17/18. A CI-integrated
version of layer 3 is still follow-up work — see "Not yet covered" below. Unauthorized-patient
access with two distinct real user accounts is also still pending: it requires creating a second
OpenEMR user, which needs to be done by a human (Claude does not create accounts or enter
passwords into forms, including on this project's own admin panel) — see that section for the
exact steps to unblock it.

## Layer 1: `src/verify.test.ts` and `src/schemas.test.ts` — run with `npm test`

| Test | Category | Guards against |
|---|---|---|
| `verified: citation pointing at a real field survives` | Invariant | Verification being so strict it rejects legitimately-grounded answers (false negative on trust) |
| `degraded: citation pointing at a nonexistent field is dropped, not trusted` | Invariant | The core anti-hallucination guarantee — a fabricated field reference must never be trusted through to the user |
| `boundary: empty patient record does not crash and yields degraded for a claim-free answer` | Boundary (missing data) | Crash or false-positive "verified" on a patient with no chart data at all |
| `boundary: empty-string source_field is treated as missing, not a crash` | Boundary (malformed input) | A malformed/blank citation crashing verification instead of failing safe |
| `regression: flattenChart field-key format stays stable` | Regression | Silent breakage of the field-key naming contract the model is prompted against, which would make every future citation fail to verify without an obvious cause |
| `agentAnswerSchema: accepts a well-formed submit_answer payload` | Invariant | The zod schema being stricter than the Anthropic tool's own `input_schema` |
| `agentAnswerSchema: rejects a tool call missing citations` | Boundary (malformed model output) | A malformed `submit_answer` call (the Anthropic tools API's `input_schema` is advisory, not enforced) reaching `verifyAnswer()` as an unchecked `as AgentAnswer` cast and crashing on `.filter` |
| `agentAnswerSchema: rejects a citation with a non-string source_field` | Boundary (malformed model output) | Silent type coercion of a malformed citation field instead of a hard rejection |
| `chatRequestSchema: accepts a minimal valid request` | Invariant | The request schema rejecting legitimate minimal requests |
| `chatRequestSchema: rejects an empty message string` | Boundary (malformed input) | The prior truthiness-only check (`!payload.message`) that a request could route around in edge cases the schema now closes |
| `chatRequestSchema: rejects a history entry with an invalid role` | Boundary (malformed input) | An invalid conversation-history role reaching the LLM prompt unchecked |

**Result at time of writing:** 11/11 passing (`npm test` inside `copilot-agent/`).

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

## Layer 3: Live deployment tests (2026-09-17/18, `clinical-copilot-agent.genesysx.workers.dev`)

### Ambiguous query, no antecedent

Asked "what about her levels?" cold (no prior turn, no lab data on this synthetic patient).
✅ Correctly interpreted "levels" as lab results, stated none are on file, listed what *is*
available (vitals) with full citations, and put "no lab results present" in `uncertain_about`
rather than guessing at a number. `verificationStatus: "verified"`, zero dropped claims.

### Multi-turn context retention

Turn 1: "What's currently active for this patient?" → cited hypertension + Lisinopril + vitals.
Turn 2 (same `conversationId`, history includes turn 1): "how long has she been on that?" →
correctly resolved "that" to Lisinopril without re-stating the patient or the question, cited the
medication's actual start date, and flagged genuine uncertainty about pre-chart history ("whether
she was on it before this recorded start date"). Confirms `ConversationTurn[]` history actually
carries context through to the model, not just persisted for its own sake.

### Load tests at 10 and 50 concurrent users

Run with `scripts/load-test.mjs` against the live Worker, real OpenEMR, real Claude Sonnet 5
calls (not mocked) — a single synthetic patient repeated with randomized questions.

| Concurrency | Requests | Errors | p50 | p95 | p99 |
|---|---|---|---|---|---|
| 10 | 10 | 0 | 8.9s | 10.9s | 10.9s |
| 50 | 50 | 0 | 10.2s | 12.6s | 14.5s |

**Three real bugs were found and fixed by this load test, not just measured around:**

1. **Crash on missing citations** (`TypeError: Cannot read properties of undefined (reading
   'length')`) — the pre-existing `toolUse.input as AgentAnswer` cast trusted the model's tool
   call blindly; a response omitting `citations` crashed `logStep`'s `answer.citations.length`.
   Fixed by [schemas.ts](src/schemas.ts)'s `agentAnswerSchema` (see Layer 1 tests above) —
   converted a hard crash into a clean, logged 502.
2. **`uncertain_about` truncation and type drift** — at 50 concurrent, ~18% of requests failed
   zod validation because `uncertain_about` (the tool schema's last field) arrived as `undefined`
   or as a bare string instead of `string[]`. Root-caused to `max_tokens: 1024` being too low
   under load (raised to 4096) and the schema being stricter than the model's actual behavior
   (now `z.preprocess` normalizes a string to a one-element array and defaults a missing value to
   `[]` — see the comment on `agentAnswerSchema` in `schemas.ts`).
3. **Non-deterministic missing `citations`** — after fixes 1–2, one residual failure mode
   remained: the model occasionally omits `citations` (the safety-critical field) entirely, on a
   single unconcurrent request as well as under load — not a concurrency artifact, just tool-use
   non-determinism. Unlike `uncertain_about`, this is *not* safe to default (an empty citations
   array on a substantive answer would defeat the anti-hallucination guarantee), so
   [agent.ts](src/agent.ts)'s `askAgent` now retries once (bounded, not a loop) before surfacing
   the error. Confirmed this brought the 50-concurrent error rate to 0/50.

**Result after all three fixes:** 0 errors across both waves (0/10, 0/50).

**Honest residual finding, not fixed today:** p50 latency (~9-10s) is materially slower than the
"answer in the time it takes to walk to the next room" framing in USERS.md would ideally want.
It's dominated by the Claude API call itself (`llm:call` is consistently the largest phase in
`agent_logs.latency_ms`). Streaming the response to the browser as it's generated (rather than
waiting for the full tool call) is the natural fix and is tracked as follow-up, not attempted
today — verification currently needs the complete citations list before anything can be shown as
`verified`, so streaming needs its own design, not a quick patch.

### Real browser UI end-to-end test, live (2026-09-18)

Every prior live test in this document used `curl` against the API directly. This one drove the
actual `renderChatPage()` UI a physician would use, through a real browser: `/login` →
OpenEMR's own login + consent screen → `/callback` → the chat page → asking a question → a
follow-up. This surfaced a bug none of the curl-based testing could have found:

**Bug:** `ui.ts` initializes `let conversationId = null` and sent it as a literal JSON `null` in
the very first `/api/chat` request of every conversation. `chatRequestSchema`'s
`conversationId: z.string().min(1).optional()` only accepts `undefined` for an absent field, not
`null` — so the schema rejected the opening message of every real conversation with a 400,
silently, since every prior test (this document's own Layer 2/3 tests included) always omitted
the field entirely rather than sending `null`. **The actual physician-facing chat UI has been
broken for the first message of every conversation since the schema was introduced on Day 2, and
nothing caught it until this end-to-end browser test.** Fixed two ways: `chatRequestSchema` now
uses `.nullish()` (accepts both `null` and `undefined`), and `ui.ts` no longer sends the key when
there's nothing to send, so the bug can't resurface from the client side either.

**Verified after the fix:** logged in via OpenEMR's real consent screen, asked "What's currently
active for this patient?" (first message — the exact case that was broken), got a verified answer
citing James Chen's real data (BP 138/88, both conditions, both medications). Asked a follow-up
("How long has he been on the statin?") in the same conversation — correctly resolved "the
statin" to Atorvastatin from context and cited its actual start date, confirming multi-turn state
survives the fix too, not just the first message.

**The lesson, stated plainly:** a strict schema is only as good as what it's tested against — unit
and curl-based tests exercised the schema correctly but never against what the real client
actually sends. This is the argument for testing the live UI end-to-end at least once per major
schema change, not just the API in isolation.

### Data-quality boundary cases, live (2026-09-18)

Layer 1's `verify.test.ts` already covered an empty-chart *unit test*. These are the same
boundary conditions confirmed against real OpenEMR patients through the full live stack —
different guarantee, since a unit test can't catch a server-side fetch bug the way a real record
can (see `AUDIT.md`'s Data Quality Audit for the panel-Observation bug this actually found).

| Patient | Design | Result |
|---|---|---|
| Dorothy Lee | Name + DOB only, nothing else | Agent reported no data across every category (problems, medications, allergies, orders) — no fabrication, `uncertain_about` populated for all four. |
| Robert Kim | One condition resolved 2019, one medication discontinued 2019 (both with real end dates) | Condition surfaced with status honestly labeled "inactive"; medication correctly absent from the active list (server-side `status=active` filter confirmed against a real inactive record, not just present in code). |

### Unauthorized-patient access with two real accounts, live (2026-09-18)

A second OpenEMR user (`frontdesk_demo`) was created by hand (account creation and password
entry are outside what Claude does even on this project's own admin panel) with **Main Menu
Role: Front Office** and tested against the same patient the admin account can read.

**First attempt: unexpectedly succeeded (200, full chart data).** This is a real, valuable
finding, not a clean pass — OpenEMR's Add User form has two separately-set fields easy to
conflate: **Main Menu Role** (governs which UI menu items a user sees — was correctly "Front
Office") and a separate **Access Control** multi-select further down the same form (the field
that actually governs permissions), which OpenEMR silently defaulted to **"Administrators"**
rather than requiring an explicit choice. Confirmed directly from the DOM
(`access_group[]`'s `selectedOptions`), not by inference. This is an insecure-by-default UX
pattern in OpenEMR itself worth flagging in `AUDIT.md`'s security findings: a form that looks
like it's restricting a new account can silently leave it fully privileged if the operator
doesn't know to check a second, separate field.

**After correcting Access Control to "Front Office" and re-testing:** `POST /api/chat` for the
same patient the admin account can read now returns `403` — `{"error":"Not authorized to view
this patient in OpenEMR"}` — and `agent_logs` records it distinctly from the admin's own
successful requests: `{"reason":"auth","httpStatus":403}` on `tool:get_patient_chart`, versus
`status: "ok"` for admin's identical request. This is the concrete, live proof that the "no
shared elevated credential" design decision in `ARCHITECTURE.md` and `KEY_METRICS.md`'s metric
#5 (authorization denial rate) is actually load-bearing: OpenEMR's own per-user authorization is
the real enforcement point, and this Worker correctly propagates its denial rather than falling
back to any other credential.

## Not yet covered (explicit gaps, not oversights)

- **Ground-truth ("did it actually get the right answer") evaluation**, as opposed to today's
  "did it only claim things it can source" evaluation — these are different questions; today's
  suite only answers the second one.
- **CI-integrated version of Layer 3** — today's live-deployment tests were run manually with
  `curl`/`scripts/load-test.mjs`, not wired into an automated pipeline.
