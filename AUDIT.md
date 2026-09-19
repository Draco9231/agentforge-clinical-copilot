# AUDIT.md — OpenEMR Fork Audit (Pre-Agent)

## Summary (read this first)

This audit covers the `Gauntlet-HQ/openemr-base-clean` fork before any agent code was added,
based on static inspection of the repository (configuration, Docker setup, API/auth
documentation, and project structure) since the public deployment was not yet live at the time
of writing — see the "Not yet verified" note at the end of each section for what still needs a
running instance to confirm.

**Most impactful finding:** `docker/development-easy/docker-compose.yml` contains a **hardcoded
GitHub personal-access-token-shaped secret** (`GITHUB_COMPOSER_TOKEN`, plus a base64 and a
space-separated-decimal encoded copy of the same value) committed in plain text, used to pull a
private Composer package during the dev image build. It's already present in the public
Gauntlet-HQ fork, so it should be treated as already-exposed rather than something we're at risk
of newly leaking — but it's a textbook example of exactly the kind of "secret committed to a
repo that gets forked repeatedly" problem this audit exists to catch, and it should be rotated by
whoever owns it and never re-added in cleartext. **If we'd skipped this audit and gone straight
to building**, this token would have been silently carried into every derived fork (including
this one, and every other student's) without anyone noticing, and — worse — we might have
followed the same pattern ourselves for the Anthropic API key or an OpenEMR OAuth client secret,
which would be a real, not theoretical, leak.

**Second finding, by design rather than bug:** the default dev/production credentials
(`admin`/`pass`, MySQL `root`/`root`) are OpenEMR's documented, intentional defaults for local
development — correct for that purpose, but a live liability if they ever reach a public
deployment unchanged. This directly shaped the deployment plan: `docker/deploy/docker-compose.yml`
requires distinct, non-default passwords via required environment variables (`${VAR:?message}`
syntax fails the deploy rather than silently falling back to the insecure default) rather than
inheriting the dev compose file's hardcoded values.

**Architecturally**, OpenEMR already ships a real OAuth2/OIDC + FHIR R4 + SMART-on-FHIR
implementation with per-scope authorization (`user/*`, `patient/*`, `system/*`) — meaning the
"Authorization & Access Control" hard problem in the project spec has a legitimate answer
*already built into the platform we're integrating with*, rather than something the agent needs
to reinvent. This single fact is what drove the architecture decision (see `ARCHITECTURE.md`) to
have the agent forward the physician's own OAuth token to every OpenEMR call instead of using a
shared service credential. Skipping this audit would very likely have led to the agent using a
single admin/service token "for simplicity," which is precisely the anti-pattern the case study's
Authorization & Access Control section warns against.

**Compliance-wise**, the codebase includes audit-logging infrastructure and the project
explicitly instructs treating all LLM providers as if a BAA were signed and using only synthetic
data — both are load-bearing constraints on the agent's design (no real PHI ever reaches
Anthropic's API in this project; the "system of record" boundary stays inside OpenEMR/Railway).

---

## Security Audit

- **Finding S-1 (High, already public):** `docker/development-easy/docker-compose.yml` hardcodes
  `GITHUB_COMPOSER_TOKEN` in plaintext (and twice more, encoded). Recommendation: rotate the
  underlying GitHub token; never reintroduce secrets into compose files — use Railway's/Cloudflare's
  secret stores (`wrangler secret put`, Railway environment variables marked sensitive) instead,
  which is exactly what this project does for `ANTHROPIC_API_KEY` and the OpenEMR DB/admin
  passwords.
- **Finding S-2 (Medium, by design in dev, real risk if copied):** default credentials
  (`admin`/`pass`, MySQL `root`/`root`) are baked into `docker/development-easy` and
  `docker/production` compose files. `docker/deploy/docker-compose.yml` (this project's Railway
  target) requires these as mandatory, unset-by-default environment variables instead.
- **Finding S-3 (fixed 2026-09-18, was Informational):** OpenEMR's OAuth2 implementation supports
  a `password` grant that the documentation itself labels "Not considered secure" / "NOT
  RECOMMENDED for production." The Co-Pilot's physician-facing login now uses
  `authorization_code` + PKCE against OpenEMR's own login/consent page instead (see
  `ARCHITECTURE.md`'s Known Limitations #2) — verified live end-to-end. The password grant
  survives only as a non-interactive test/automation path (`POST /api/login`), documented as
  such, never the real physician flow.
- **Finding S-4 (Positive):** OpenEMR's REST/FHIR layer supports granular OAuth scopes
  (`user/Patient.read`, `system/*.read`, `.cruds` fine-grained permissions) and a proper
  `client_credentials` grant with `private_key_jwt` for backend services — the right long-term
  answer for the agent's authentication, once time allows implementing JWKS-based client
  assertions.
- **Finding S-5 (Medium, insecure-by-default UX in OpenEMR itself, confirmed live 2026-09-18):**
  Administration → Users → Add User has two separately-set fields that look related but aren't:
  **Main Menu Role** (which UI menu items a user sees) and a separate **Access Control**
  multi-select further down the same form (the field that actually governs permissions).
  Creating a test user with Main Menu Role correctly set to "Front Office" still left it fully
  privileged — OpenEMR had silently defaulted Access Control to **"Administrators"** rather than
  requiring an explicit choice, confirmed directly from the DOM
  (`access_group[]`'s `selectedOptions`). First attempt at this project's own unauthorized-access
  eval test (`EVAL_DATASET.md`) returned full chart data (200) instead of the expected 401/403,
  entirely because of this default — not a bug in this project's own authorization design, which
  correctly denied access (403, logged distinctly from admin's requests) once Access Control was
  corrected. Recommendation: any OpenEMR account provisioning process (including this project's
  own future onboarding docs) must explicitly set Access Control, never rely on the form's
  default, and should spot-check `access_group` in the database or via the API rather than
  trusting Main Menu Role as a proxy for actual permissions.

## Performance Audit

- OpenEMR's dev/production Docker images bundle Apache + PHP-FPM + a MariaDB dependency;
  cold-start health checks in both compose files allow up to 3 minutes (`start_period: 3m`)
  before considering the app unhealthy — meaning first-request latency after a deploy or restart
  is expected to be materially worse than steady-state.
- The agent's own latency budget is dominated by two network hops per request (OpenEMR FHIR
  calls, then the Anthropic API call) — both instrumented per-step in `agent_logs.latency_ms`
  (see `ARCHITECTURE.md`) specifically so this doesn't have to be guessed at.
- **Verified 2026-09-17/18, against the live deployment:** p50/p95/p99 at 10 and 50 concurrent
  users (`copilot-agent/scripts/load-test.mjs`; full results and the three real bugs the load
  test surfaced and fixed are in `copilot-agent/EVAL_DATASET.md`'s Layer 3). Summary: 0 errors at
  both concurrency levels after fixes, p50 ~9-10s, p95 ~11-13s, p99 ~11-15s. The load test's own
  honest finding: this latency is dominated by the Claude API call itself and is materially
  slower than USERS.md's "time to walk to the next room" framing would ideally want — streaming
  the response is the natural fix, tracked as follow-up, not a same-day patch.
- **Still not yet verified:** baseline CPU/memory under load (Cloudflare Workers' billing model
  makes this less load-bearing than it would be on a fixed-capacity host, but not zero) and FHIR
  query latency specifically isolated from the LLM call's latency.

## Architecture Audit

- Modern code lives under PSR-4 `/src/` (OpenEMR\ namespace); a large amount of legacy
  procedural code remains under `/library/` and is explicitly documented (`CLAUDE.md`) as *not*
  the standard to imitate for new code — a real risk for anyone unfamiliar with the codebase
  copy-pasting legacy patterns.
- The integration point for the Co-Pilot is OpenEMR's existing REST/FHIR API layer
  (`apis/`, documented in `Documentation/api/`) — not `/interface/` (the web UI layer) or
  `/library/` (legacy business logic). This keeps the agent fully decoupled from OpenEMR's PHP
  runtime and upgrade cycle, at the cost of only having access to what the FHIR API already
  exposes (a real, documented constraint, not an oversight).
- Data lives in MariaDB (relational, system of record for structured clinical data) and CouchDB
  (used by the dev stack for a document-oriented service, not touched by this project).

## Data Quality Audit

**Verified 2026-09-18** against four real patients spanning the completeness spectrum a live
deployment will actually see — not just the one thin record from Day 1. Rationale: this audit's
whole point is catching "missing fields, inconsistent formatting, duplicate records, and stale
data" before they become agent failure modes (per this project's own spec), which is impossible
to actually check against a single patient with one condition and mostly-`n/a` vitals.

| Patient | Design | What it exercises |
|---|---|---|
| Maria Alvarez | Original Day-1 demo patient, minimal | Baseline |
| James Chen | Rich: 2 active conditions, 2 active meds, full vitals (incl. real BP) | Component-based Observations, panel/grouper Observations, a normal "lots of data" visit |
| Dorothy Lee | Deliberately empty: name + DOB only, nothing else | The true empty-record boundary case, live rather than only unit-tested |
| Robert Kim | Deliberately stale: one condition resolved in 2019, one medication discontinued in 2019, both with real begin/end dates | Whether "active-only" filtering actually holds up against real inactive/historical records |

**Real finding, not hypothetical:** building James Chen's record surfaced a genuine bug in
`fetchPatientChart` that no synthetic single-patient test would have caught — OpenEMR's FHIR
server represents one vitals-form save as a *panel* Observation referencing ~15 child
Observations (temp, pulse, BP, several pediatric-oriented percentile rows OpenEMR emits
regardless of patient age), not everything nested under one Observation's `component[]`. At the
original `_count=10` fetch limit, blood pressure — clinically the single most important vital —
was silently dropped before the agent ever saw it, and the agent correctly said "not available"
rather than guessing, which *masked* the bug instead of surfacing it. Full root cause and fix in
`ARCHITECTURE.md`'s known limitation (5) and `copilot-agent/src/openemr.ts`. This is exactly the
kind of thing the spec's Data Quality Audit pillar exists to catch — a failure mode invisible in
a demo with one sparse patient, real the moment a patient has a normal amount of chart data.

**Verified working as designed:**
- **Empty record (Dorothy Lee):** the agent reports no data across every category (problems,
  medications, allergies, orders) rather than fabricating a plausible-sounding but false summary.
- **Stale data (Robert Kim):** the resolved 2019 condition is surfaced with its status honestly
  labeled "inactive," not presented as current; the discontinued medication is correctly excluded
  from the active medication list by the existing `status=active` server-side filter
  (`MedicationRequest?...&status=active` in `openemr.ts`) — confirmed against a real inactive
  record, not just the filter's presence in code.
- Conditions are *not* filtered server-side (see the comment in `fetchPatientChart` — OpenEMR's
  FHIR server doesn't reliably honor `clinical-status=active` there), so a resolved condition
  does reach the model, but its status is surfaced accurately rather than hidden or mislabeled.

## Compliance & Regulatory Audit

- Per this project's own governing instructions: only synthetic/demo patient data is used in
  this codebase, and all LLM providers are treated as if a signed BAA were in place — both
  enforced as working assumptions in `ARCHITECTURE.md`, not just stated here.
- No real patient data (PHI) should ever be entered into this deployment. This is an operating
  rule for this project, not a technical control the software enforces — flagged as a gap:
  today's shell has no automated PHI-detection or synthetic-data-only guardrail.
- Audit logging: OpenEMR itself has native audit-logging capability (`library/` event/audit
  tables); the agent's own correlation-ID-tagged logs (`agent_logs` in D1) are additive to that,
  not a replacement for it. **Not yet verified:** whether OpenEMR's own audit log is enabled by
  default in the dev/production compose configs — to confirm once deployed.
- Data retention / breach notification: no explicit policy exists yet for the agent's own D1
  data (conversation transcripts, logs). Tracked as required follow-up before any non-synthetic
  use.
