# Clinical Co-Pilot — Architecture

## Summary (read this first)

The Clinical Co-Pilot is deliberately **not** built as a modification to OpenEMR's own PHP
codebase. It's a separate service that talks to OpenEMR the same way any third-party clinical
app would: through OpenEMR's existing FHIR R4 API. OpenEMR (PHP/MariaDB) runs on its own host —
today, a Docker Compose stack, deployed to Railway; long-term, wherever the hospital already
runs its EHR. The agent itself is a Cloudflare Worker backed by Cloudflare D1 (SQLite), which
holds only the agent's own operational data — conversation turns, tool-call logs, verification
outcomes — never a copy of patient records. This split exists because Cloudflare's edge runtime
cannot run PHP or MySQL, and forcing OpenEMR itself onto that runtime would mean forking deep
into infrastructure code we have no reason to touch. Keeping OpenEMR untouched and integrating
at its API boundary is also just the cleaner engineering call: it's the same seam any real
hospital integration would use, and it means our failure modes are isolated from OpenEMR's own.

The single biggest architectural decision is **how authorization works**: the agent holds no
credential of its own for reading patient data. Every request to OpenEMR is made using the
physician's *own* OpenEMR OAuth bearer token, forwarded as-is. If a physician isn't allowed to
see a given patient in OpenEMR, they aren't allowed to see it through the Co-Pilot either —
OpenEMR's own role/ACL system is the enforcement point, not a reimplementation of it in the
Worker. **As of 2026-09-18, the physician-facing login is `authorization_code` + PKCE** against
OpenEMR's own login/consent page (`/login`, `/callback` in `index.ts`; PKCE machinery in
`oauth.ts`) — this Worker no longer sees a password at all, only a short-lived authorization code
it exchanges server-side. The earlier OAuth2 password grant is kept only as a non-interactive
escape hatch for automated testing (`POST /api/login`, used by `scripts/load-test.mjs` and eval
curl scripts) — never the real physician flow anymore.

The second major decision is **where verification sits**. The model never states a fact about
the patient from its own training data — it's given a flattened snapshot of the patient's active
conditions, active medications, and recent observations as field-keyed data, and it is forced
(via Claude's tool-use with `tool_choice` pinned to a `submit_answer` schema) to cite the exact
field key backing every claim. A deterministic post-processing step then checks that every cited
field key actually exists in the data that was fetched — not a rephrasing check, just "did you
point at something real." Citations pointing at fields that don't exist are stripped and the
response is marked `degraded` rather than shown as fully verified, which the UI surfaces
directly to the physician rather than hiding.

**Known limitations, stated plainly:** (1) **fixed 2026-09-18:** verification previously only
checked that a citation's field exists, not that the claim faithfully represents it. A second,
batched LLM-as-judge pass (`judge.ts`) now checks every surviving citation's claim against its
actual field value in one follow-up call (not one call per citation, to bound the added latency
to a single extra round-trip regardless of citation count) and downgrades `verified` to
`degraded` if any claim is judged unfaithful. Deliberately fails open — a judge-call error leaves
the existing existence-check result unchanged rather than blocking the response, since the
existence check remains the safety-critical gate and this is additive to it, not a replacement.
Verified live: the added step (`verify:judge` in `agent_logs`/Langfuse) runs correctly and adds
~1.2-1.5s to end-to-end latency (already-elevated p50, see `EVAL_DATASET.md`'s Layer 3 — this
makes that honest tradeoff slightly worse, not something to pretend away). Could not organically
trigger a live catch across several real questions — the model's own claims were consistently
faithful, including correctly declining to call blood pressure "normal" when it was actually
elevated — so the unfaithful-claim path is proven via `judge.test.ts`'s synthetic case
(`filterKnownClaims`) plus confirmation that the live mechanism runs end-to-end, not by a live
example of it actually degrading a response. (2) **fixed 2026-09-18:** the password-grant login
(a stand-in that meant this Worker saw a
plaintext password in transit at login) is replaced by `authorization_code` + PKCE for the real
physician flow — verified live end-to-end via the actual browser UI, including OpenEMR's own
consent screen listing exactly the scopes requested. Password grant survives only as a
non-interactive test/automation path, documented as such in `index.ts`. (3) there is no
clinical rule engine yet (drug interactions, dosage thresholds) — today's agent can tell you
what's on the chart, not whether it's clinically sound. (4) tool coverage is deliberately narrow
(Patient/Condition/MedicationRequest/Observation) and traces directly to USERS.md's UC-1–UC-3;
broader chart access is a later stage, not a bigger fetch bolted on today. (5) **fixed 2026-09-18,
against a real multi-vital patient (Day 1's fix was necessary but incomplete):** the Observation
mapping falls through `valueQuantity` → `valueString` → `component[]` (`observationValue()` in
`openemr.ts`), so a component-based panel like blood pressure surfaces its actual numbers. But
that alone didn't fix live blood-pressure retrieval, because OpenEMR's FHIR server represents one
vitals-form save as a *panel* Observation (`hasMember` pointing at ~15 child Observations — temp,
pulse, height, weight, BP, several pediatric-oriented percentile rows OpenEMR emits regardless of
patient age), not everything under one Observation's `component[]`. At the original `_count=10`,
the panel plus higher-priority children filled the whole budget before the fetch ever reached
blood pressure (last in the list) — it was dropped before `observationValue()` ever ran, not
mis-parsed by it. Fixed by filtering out panel/grouper Observations (`isPanelObservation()`, they
carry no value of their own) and raising `_count` to 30 with a 15-item cap after filtering, sized
to what one real encounter's vitals actually produces. Verified live: asking about a patient with
elevated, untreated BP correctly surfaced 138/88 and separately flagged "no antihypertensive
listed" as a genuine clinical uncertainty, rather than fabricating one. Covered by regression
tests in `openemr.test.ts`. (6) the model
occasionally omits `citations` from its tool call entirely — non-deterministic, not
concurrency-specific (see `EVAL_DATASET.md`'s Layer 3). A bounded single retry in `askAgent`
handles this; if it were to persist across the retry too, that would surface as a 502 rather than
ever showing an unverified answer. (7) **fixed 2026-09-18, found only by testing the real browser
UI end-to-end, not by any curl-based test:** `ui.ts` sends a literal `conversationId: null` (not
an omitted key) on the first message of every conversation, since it initializes
`let conversationId = null`. `chatRequestSchema`'s `.optional()` only permits `undefined`, so
every fresh conversation's opening message 400'd in the actual physician-facing UI since the
schema was introduced — invisible to every prior test because they all omitted the field rather
than sending `null` explicitly. Fixed both ways: the schema now uses `.nullish()` (accepts
`null` and `undefined`), and `ui.ts` no longer sends the key at all when there's nothing to send.
The lesson, stated plainly: strict schemas catch what you test them against, not what the real
caller actually sends — this is why `run`-testing the live UI, not just the API, is worth doing.

---

## System diagram

```
Physician's browser
      │  (redirected to OpenEMR's own login + consent page — never enters a password here)
      ▼
Cloudflare Worker (clinical-copilot-agent)
  ├─ /login       → redirects to OpenEMR's /authorize with PKCE challenge + state (oauth.ts)
  ├─ /callback    → exchanges the authorization code server-side, hands token to the browser
  ├─ /api/login   → OAuth2 password grant — test/automation only, not the physician flow
  ├─ /api/chat    → the agent loop (below)
  ├─ /health /ready
  └─ Cloudflare D1 (conversations, messages, agent_logs)
      │
      │  every OpenEMR call carries the PHYSICIAN'S OWN bearer token
      ▼
OpenEMR (Docker Compose: openemr + mariadb), deployed on Railway
  └─ FHIR R4 API (Patient, Condition, MedicationRequest, Observation)
```

## Request flow for `/api/chat`

1. A correlation ID (`crypto.randomUUID()`) is generated for the request and attached to every
   log line and D1 row produced while handling it — this is the thread that lets a full trace be
   reconstructed from logs alone, per the engineering requirements.
2. The Worker calls OpenEMR's FHIR API for `Patient`, `Condition` (active), `MedicationRequest`
   (active), and the 10 most recent `Observation`s — using the caller's bearer token. A 401/403
   from OpenEMR is passed straight back to the client; it is not retried with a different
   credential, because there is no other credential to fall back to. This is deliberate: it means
   the Co-Pilot can never accidentally show a physician a patient OpenEMR itself would have
   blocked them from.
3. The fetched chart is flattened into `field_key: value` pairs (e.g. `medications[0]`) and
   passed to Claude (Sonnet 5) as the *only* source of patient-specific fact, with an explicit
   system-prompt instruction not to use outside medical knowledge to state facts about this
   patient. The model must respond via the `submit_answer` tool (forced with `tool_choice`),
   whose schema requires a citation (`claim` + `source_field`) for every factual statement.
4. The verification step (`src/verify.ts`) checks each cited `source_field` against the actual
   flattened chart. Citations pointing at non-existent fields are dropped and the response is
   marked `degraded`; a response with zero surviving citations plus zero claims is `verified`
   trivially (e.g. "I don't have that information").
5. The user's message and the assistant's summary are persisted to D1 (`messages`), and every
   step above writes a row to `agent_logs` with status, latency, and a small non-PHI detail blob.
6. The response — summary, citations, `uncertain_about` list, and verification status — is
   returned to the browser, which renders the verification badge and source list inline instead
   of presenting the summary as unqualified fact.

## Failure modes (what happens when things break)

| Failure | Behavior |
|---|---|
| OpenEMR rejects the token (401/403) | Request fails with the same status; no retry with a different credential. |
| OpenEMR unreachable | 502 to the client, logged as `tool:get_patient_chart` / `error`. |
| Anthropic API error or timeout | 502 to the client with a plain-language message; logged as `llm:call` / `error`. Never silently returns a partial or fabricated answer. |
| Model cites a nonexistent field | Response is served but marked `degraded`, with the dropped claims listed in the log detail and available to the client. |
| D1 write fails (logging or persistence) | Logged to `console.error` but never fails the user-facing request — observability must not become a new outage vector. |

## Why Cloudflare Workers + D1 for the agent (and not, say, a container next to OpenEMR)

- Matches the user's existing Cloudflare account/infra choice for this project.
- Correlation-ID-tagged structured logs ship to Cloudflare's built-in observability
  (`wrangler tail`) and, as of 2026-09-18, to a Langfuse dashboard (`langfuse.ts`) — both with
  zero extra infrastructure to run.
- D1 is sufficient for the agent's own state (conversations, logs) — it never needs to be a
  general-purpose relational store, since OpenEMR's MariaDB remains the system of record for
  patient data.
- Statelessness of the Worker means horizontal scaling under concurrent clinical users (the
  load-test requirement) doesn't require session affinity or shared memory.

## Roadmap

**Done 2026-09-17/18 (Days 2–3):**
- Strict runtime schema validation (zod) for the model's tool output and both POST request
  bodies — see `schemas.ts` and the PR that introduced it.
- `Observation.component[]` parsing fix and the deeper panel/grouper-Observation fetch bug it
  led to (known limitation #5 above) — found and fixed against a real multi-vital patient.
- Eval suite expanded with live-deployment tests: ambiguous queries, multi-turn context
  retention, load tests at 10/50 concurrent users with p50/p95/p99 capture — see
  `EVAL_DATASET.md`'s Layer 3, including three real bugs the load test found and fixed.
- Data Quality Audit completed against four real patients spanning the completeness spectrum
  (rich, sparse/empty, stale/inactive) — see `AUDIT.md`.
- `authorization_code` + PKCE for the physician-facing login, replacing the password-grant
  stopgap — known limitation #2 above, verified live end-to-end.
- A real bug in the live chat UI (`conversationId: null` on every fresh conversation's first
  message, 400ing since the schema was introduced) — known limitation #7 above.
- 3+ alert definitions — see `copilot-agent/ALERTS.md`.
- Observability dashboard (Langfuse, HIPAA-region Cloud instance) — `logStep` mirrors every step
  (correlation ID, status, latency, the same non-PHI detail blob already written to D1) to
  Langfuse via `langfuse.ts`, fire-and-forget so a dashboard outage can't affect the physician
  request. Verified live: real request traces confirmed in Langfuse with correct step names,
  correlation IDs, and latencies matching `agent_logs` exactly. Two real bugs found and fixed
  getting here, both documented in `langfuse.ts`'s comments: (1) the wrong Langfuse Cloud host
  was initially assumed — the correct one is a HIPAA-compliant region, not the plain default;
  (2) the integration's own error handling initially checked only for network failure, not HTTP
  error responses, which would have let a rejected ingestion "succeed" silently — fixed to check
  `res.ok` and log the actual error body. Known, dated follow-up: built on Langfuse's legacy v3
  ingestion API, which sunsets 2026-11-16 (past this project's Sunday final deadline, so shipping
  now rather than building OTLP ingestion this close to that deadline was the deliberate call).
- LLM-as-judge second-pass verification of claim-to-source faithfulness — known limitation #1
  above. Adds ~1.2-1.5s to end-to-end latency, a real cost against an already-elevated p50 not
  papered over.
- Unauthorized-patient access test with two distinct real user accounts — completed
  2026-09-18, and it surfaced a real insecure-by-default finding in OpenEMR's own Add User form
  along the way (`AUDIT.md`'s Finding S-5) before the actual 403-denial result was confirmed
  live. See `EVAL_DATASET.md`.

**Still deferred:**
- Streaming `/api/chat` responses — the load test's honest finding is that p50 latency (~9-10s,
  now ~11-12s with the LLM-as-judge pass added) is dominated by the Claude API call and is slower
  than ideal for the 90-second-window use case; streaming needs its own design since verification
  currently needs the complete answer first.
