# Clinical Co-Pilot Agent

The AI agent half of the AgentForge project — a Cloudflare Worker that sits beside (not inside)
the OpenEMR fork in this repo. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the full design
rationale; this file is just setup/run instructions.

## What this is

A conversational agent that answers a physician's questions about a specific patient, using only
that patient's real OpenEMR chart data (fetched live via FHIR, using the physician's own OpenEMR
login), with every claim checked against a real chart field before being shown.

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars   # then put your real Anthropic API key in .dev.vars
npm run dev                       # starts the Worker at http://localhost:8787
```

By default it points at `https://localhost:9300` for OpenEMR (see `wrangler.jsonc`'s `vars`).
Update `OPENEMR_BASE_URL` there (or via `wrangler dev --var OPENEMR_BASE_URL:...`) to point at a
real running OpenEMR instance — locally or the deployed Railway one.

Open `http://localhost:8787/` for the built-in chat UI, or use `postman_collection.json`.

## Testing

```bash
npm test
```

Runs `src/verify.test.ts` — the verification/anti-hallucination logic's unit tests — via Node's
built-in test runner with type-stripping (no extra test framework needed). See
[`EVAL_DATASET.md`](./EVAL_DATASET.md) for what's covered and what isn't yet.

## Deploying

```bash
npx wrangler secret put ANTHROPIC_API_KEY    # one-time, per environment
npm run deploy
```

D1 database `clinical-copilot-db` is already provisioned and bound in `wrangler.jsonc`
(`schema.sql` applied to both `--local` and `--remote`). Re-run
`wrangler d1 execute clinical-copilot-db --remote --file=./schema.sql` if the schema changes.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness — always 200 if the process is up. |
| `GET /ready` | Readiness — actually checks D1, OpenEMR, and that the Anthropic key is configured. Returns 503 if anything is down. |
| `GET /` | Minimal chat UI for the demo. |
| `POST /api/login` | Proxies OpenEMR's OAuth2 password grant; returns a bearer token to use on the endpoints below. |
| `GET /api/patients` | Proxied FHIR patient search, using the caller's own bearer token. |
| `POST /api/chat` | The agent. Requires `Authorization: Bearer <openemr token>`. Body: `{ patientId, message, conversationId?, history? }`. |
