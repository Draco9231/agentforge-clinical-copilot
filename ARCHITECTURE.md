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
Worker. Today's shell uses OpenEMR's OAuth2 **password grant** to obtain that token (documented
below as a known, deliberate shortcut — not something to carry into production).

The second major decision is **where verification sits**. The model never states a fact about
the patient from its own training data — it's given a flattened snapshot of the patient's active
conditions, active medications, and recent observations as field-keyed data, and it is forced
(via Claude's tool-use with `tool_choice` pinned to a `submit_answer` schema) to cite the exact
field key backing every claim. A deterministic post-processing step then checks that every cited
field key actually exists in the data that was fetched — not a rephrasing check, just "did you
point at something real." Citations pointing at fields that don't exist are stripped and the
response is marked `degraded` rather than shown as fully verified, which the UI surfaces
directly to the physician rather than hiding.

**Known limitations, stated plainly:** (1) verification checks that a citation exists, not that
the model's prose is a faithful paraphrase of it — a second LLM-as-judge pass is the natural next
step. (2) the password-grant login is a stand-in for a real `authorization_code` + PKCE flow;
it currently means this Worker sees a plaintext password in transit at login. (3) there is no
clinical rule engine yet (drug interactions, dosage thresholds) — today's agent can tell you
what's on the chart, not whether it's clinically sound. (4) tool coverage is deliberately narrow
(Patient/Condition/MedicationRequest/Observation) and traces directly to USERS.md's UC-1–UC-3;
broader chart access is a later stage, not a bigger fetch bolted on today.

---

## System diagram

```
Physician's browser
      │  (logs in with OpenEMR username/password)
      ▼
Cloudflare Worker (clinical-copilot-agent)
  ├─ /api/login   → proxies OAuth2 password grant to OpenEMR, returns bearer token to browser
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
  (`wrangler tail` today; Logpush/dashboard integration is a Stage-2 item) with zero extra
  infrastructure to run.
- D1 is sufficient for the agent's own state (conversations, logs) — it never needs to be a
  general-purpose relational store, since OpenEMR's MariaDB remains the system of record for
  patient data.
- Statelessness of the Worker means horizontal scaling under concurrent clinical users (the
  load-test requirement) doesn't require session affinity or shared memory.

## Roadmap (explicitly deferred past today)

- Swap password grant for `authorization_code` + PKCE (or SMART EHR launch, since the agent is
  meant to be embedded *in* OpenEMR) so no credential passes through the Worker.
- LLM-as-judge second-pass verification of claim-to-source faithfulness, not just field existence.
- Observability dashboard (Langfuse/Braintrust) wired to the existing correlation IDs.
- Eval suite covering the boundary/invariant/regression cases required by the engineering
  requirements (missing data, ambiguous queries, unauthorized access attempts).
- Load tests at 10/50 concurrent users with p50/p95/p99 capture.
