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
- **Finding S-3 (Informational):** OpenEMR's OAuth2 implementation supports a `password` grant
  that the documentation itself labels "Not considered secure" / "NOT RECOMMENDED for production."
  Today's Co-Pilot shell uses it anyway (see `ARCHITECTURE.md`'s Known Limitations) because it's
  the fastest path to a per-user-scoped token for a same-day demo on synthetic data. This is
  tracked as required follow-up work (`authorization_code` + PKCE / SMART EHR launch), not treated
  as acceptable long-term.
- **Finding S-4 (Positive):** OpenEMR's REST/FHIR layer supports granular OAuth scopes
  (`user/Patient.read`, `system/*.read`, `.cruds` fine-grained permissions) and a proper
  `client_credentials` grant with `private_key_jwt` for backend services — the right long-term
  answer for the agent's authentication, once time allows implementing JWKS-based client
  assertions.

## Performance Audit

- OpenEMR's dev/production Docker images bundle Apache + PHP-FPM + a MariaDB dependency;
  cold-start health checks in both compose files allow up to 3 minutes (`start_period: 3m`)
  before considering the app unhealthy — meaning first-request latency after a deploy or restart
  is expected to be materially worse than steady-state.
- The agent's own latency budget is dominated by two network hops per request (OpenEMR FHIR
  calls, then the Anthropic API call) — both instrumented per-step in `agent_logs.latency_ms`
  (see `ARCHITECTURE.md`) specifically so this doesn't have to be guessed at.
- **Not yet verified (requires live deployment):** actual FHIR query latency under OpenEMR's
  real schema/indexes, baseline CPU/memory under load, and p50/p95/p99 under 10 and 50 concurrent
  users. Tracked as required follow-up (`AI_COST_ANALYSIS.md` / load-test deliverables).

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

- **Not yet verified (requires live deployment with sample data):** completeness/consistency of
  the sample patient data has not been inspected yet — this is first on the list once OpenEMR is
  live on Railway, since every agent failure mode in the "missing/incomplete record" category
  depends on knowing what the demo data actually looks like.
- Structurally, OpenEMR's FHIR resources (`Condition.clinicalStatus`, `MedicationRequest.status`)
  carry explicit status/lifecycle fields our chart-fetch code filters on (`active` only) — this
  reduces but does not eliminate stale-data risk (e.g. a condition never marked resolved).

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
