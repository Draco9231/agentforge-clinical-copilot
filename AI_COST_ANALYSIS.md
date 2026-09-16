# AI Cost Analysis

## Actual dev spend (today)

- Anthropic API: negligible so far — Worker-side smoke testing today used local
  request/response inspection, not live model calls billed against a real key yet at time of
  writing. Real per-call cost will be tracked going forward via `agent_logs` (add a `tokens_used`
  / `cost_usd` column once live traffic starts — currently deferred, see ARCHITECTURE.md roadmap).
- Cloudflare: Workers + D1 usage today is within the free tier (a handful of requests, a few KB
  of D1 rows). $0 actual spend.
- Railway: OpenEMR deployment not yet live at time of writing; Railway's usage-based pricing for
  a small always-on container + managed MySQL is estimated below.

## Cost model (not simply cost-per-token × users)

Per-query LLM cost is only one line item. The real cost curve is dominated by **infrastructure
that has to scale in steps, not linearly** — OpenEMR's database, Railway's compute tier, and
Cloudflare's free-tier ceilings all have step-function costs at certain scale points.

### Per-query LLM cost estimate

Each `/api/chat` call sends: system prompt + flattened chart (~300–800 tokens depending on how
much history the patient has) + conversation history + the question, and receives a structured
`submit_answer` tool response (~150–400 tokens). Estimated **~1,500 input / ~400 output tokens
per query** at Claude Sonnet pricing → roughly **$0.01–0.02 per query** (order-of-magnitude;
exact figure depends on current published Anthropic pricing at time of billing, not fixed here).

### Scale scenarios

| Users | Assumptions | LLM cost/mo (est.) | Infra changes required |
|---|---|---|---|
| **100** | ~5 queries/user/day, 22 clinic days/mo → ~11,000 queries/mo | ~$110–220/mo | Current architecture as-is: single Railway OpenEMR instance, Cloudflare free/low tier. No changes needed. |
| **1,000** | Same usage pattern → ~110,000 queries/mo | ~$1,100–2,200/mo | Railway container needs a real compute tier (not hobby/free); OpenEMR's MySQL needs connection pooling and likely a managed DB tier bump. Cloudflare Workers/D1 still comfortably within paid-tier limits. Start tracking per-query cost in `agent_logs` rather than estimating. |
| **10,000** | → ~1.1M queries/mo | ~$11,000–22,000/mo | Single OpenEMR instance becomes a real bottleneck — this is where the "one hospital, one OpenEMR" assumption breaks; likely need per-tenant OpenEMR instances or a read-replica strategy for FHIR reads. Prompt-caching the chart-fetch/system-prompt portion becomes cost-material at this volume (Anthropic prompt caching can cut repeated-context cost substantially). D1 read volume may approach limits requiring a dedicated logging pipeline (e.g., Cloudflare Logpush to R2/analytics) instead of D1 as the log store. |
| **100,000** | → ~11M queries/mo | ~$110,000–220,000/mo | This is a genuinely different system: multi-tenant OpenEMR fleet (one per hospital/health system, not one shared instance), a real observability backend (Langfuse/Braintrust self-hosted or enterprise tier, not ad-hoc D1 queries), dedicated rate limiting per tenant, and a serious look at whether every query needs a full LLM call or whether a cache/shortcut layer (e.g., "same question asked twice in one visit") can cut volume. At this scale, LLM cost is no longer the dominant line item — the engineering cost of running reliable multi-tenant infrastructure is. |

## What this analysis deliberately does not claim

Exact dollar figures above are order-of-magnitude estimates for a same-day submission, not a
priced-out contract. The one claim we do stand behind: **cost does not scale as a flat multiple
of users**, because infrastructure hits step-changes (pooling, caching, multi-tenancy) well before
100,000 users, and pretending otherwise would be the actual audit finding here.
