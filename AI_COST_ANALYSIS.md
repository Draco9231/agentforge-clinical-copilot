# AI Cost Analysis

## Actual dev spend

**Updated 2026-09-18 with real measured data — the Day 1 version of this document estimated
per-query cost without ever having captured Anthropic's own token usage.** Auditing this
project's own observability requirements found that neither `agent.ts` nor `judge.ts` read the
`usage` field Anthropic's API returns on every response — a real gap against the case study's
own requirement to answer "how many tokens were consumed, and at what cost?" from the logs.
Fixed in `cost.ts`, wired into both LLM call sites, logged per-request in `agent_logs` and
Langfuse. This document now reflects real numbers, not estimates.

**Pricing used (confirmed via Anthropic's published rates, 2026-09-18):** Claude Sonnet 5 is
**$2 / $10 per million input/output tokens** — the introductory rate that was kept as standard
rather than increasing to $3/$15 as originally scheduled for 2026-09-01.

**Real measured cost, 3 sampled live queries against the deployed Worker:**

| Query | `llm:call` tokens (in/out) | `verify:judge` tokens (in/out) | Total cost |
|---|---|---|---|
| "What is currently active for this patient?" | 1995 / 794 | 1706 / 41 | $0.01575 |
| "How long has he been on the statin?" | 1999 / 258 | 888 / 41 | $0.00876 |
| "Is his blood pressure normal?" | 2000 / 651 | 1408 / 41 | $0.01374 |

**Average: ~$0.013/query** — two LLM calls per query (the primary answer plus the LLM-as-judge
faithfulness pass added 2026-09-18), not one. The judge call's input tokens track the number of
citations being checked (it re-sends each claim + its cited field value), while its output is
consistently small (~41 tokens) since it only ever returns a list of flags, never new prose.

**Actual dev-phase Anthropic spend:** every load test, eval-suite question, and manual live test
across this project's build (2026-09-16 through 2026-09-18) hit the real Anthropic API — this was
never a mocked or simulated cost. At the measured ~$0.013/query blended rate, the ~150-200 real
`/api/chat` calls made during development (50-and-10-concurrent load test waves ×2 rounds each,
plus eval-suite and manual verification queries) come to a rough **$2-3 in actual API spend** for
the whole build — genuinely small, but real, not zero as the Day 1 version of this document
claimed before any live traffic existed.

**Cloudflare:** Workers + D1 usage remains within the free tier at this traffic volume. $0 actual
spend.

**Railway:** OpenEMR + MariaDB, small always-on container — Railway's usage-based pricing applies
now that it's been running continuously since 2026-09-16 (see `docker/deploy/RAILWAY_DEPLOY.md`
for the exact plan/tier); not itemized here since it's fixed regardless of query volume, unlike
the LLM cost above.

**Langfuse:** the HIPAA-region Cloud tier used for the observability dashboard has its own
pricing separate from Anthropic API cost — not itemized here (check current Langfuse Cloud
pricing for the HIPAA-compliant tier specifically, which typically differs from the standard
tier), but worth noting explicitly as a new line item introduced 2026-09-18 that the Day 1
version of this document didn't have to account for.

## Cost model (not simply cost-per-token × users)

Per-query LLM cost is only one line item. The real cost curve is dominated by **infrastructure
that has to scale in steps, not linearly** — OpenEMR's database, Railway's compute tier, and
Cloudflare's free-tier ceilings all have step-function costs at certain scale points.

### Per-query LLM cost, real measured baseline

**~$0.013/query** (two calls: primary answer + LLM-as-judge), measured directly from live traffic
via `cost.ts`, not estimated. This is the number the scale table below is built on — a real
improvement in confidence over Day 1's order-of-magnitude guess, though still a small sample (3
queries against one patient) rather than a statistically large one.

### Scale scenarios

| Users | Assumptions | LLM cost/mo (measured rate) | Infra changes required |
|---|---|---|---|
| **100** | ~5 queries/user/day, 22 clinic days/mo → ~11,000 queries/mo | ~$143/mo | Current architecture as-is: single Railway OpenEMR instance, Cloudflare free/low tier. No changes needed. |
| **1,000** | Same usage pattern → ~110,000 queries/mo | ~$1,430/mo | Railway container needs a real compute tier (not hobby/free); OpenEMR's MySQL needs connection pooling and likely a managed DB tier bump. Cloudflare Workers/D1 still comfortably within paid-tier limits. Langfuse Cloud likely needs a paid tier at this event volume (two LLM-call events logged per query). |
| **10,000** | → ~1.1M queries/mo | ~$14,300/mo | Single OpenEMR instance becomes a real bottleneck — this is where the "one hospital, one OpenEMR" assumption breaks; likely need per-tenant OpenEMR instances or a read-replica strategy for FHIR reads. Prompt-caching the chart-fetch/system-prompt portion becomes cost-material at this volume (Anthropic prompt caching can cut repeated-context cost substantially) — the judge call in particular re-sends the same chart-derived field values already sent to the primary call, a real prompt-caching candidate. D1 read volume may approach limits requiring a dedicated logging pipeline (e.g., Cloudflare Logpush to R2/analytics) instead of D1 as the log store. |
| **100,000** | → ~11M queries/mo | ~$143,000/mo | This is a genuinely different system: multi-tenant OpenEMR fleet (one per hospital/health system, not one shared instance), Langfuse self-hosted or enterprise tier rather than the Cloud HIPAA tier, dedicated rate limiting per tenant, and a serious look at whether every query needs a full LLM-as-judge pass or whether it can be sampled (e.g. judge 1 in N responses, or only responses with `degraded` status from the existence check) rather than run on every single query. At this scale, LLM cost is no longer the dominant line item — the engineering cost of running reliable multi-tenant infrastructure is. |

## What this analysis deliberately does not claim

The scale-scenario dollar figures are extrapolations from a 3-query real sample, not a priced-out
contract — a larger sample would tighten the confidence interval, and is explicit follow-up work,
not something to overstate here. The two claims this document does stand behind: **cost does not
scale as a flat multiple of users**, because infrastructure hits step-changes (pooling, caching,
multi-tenancy) well before 100,000 users; and **the per-query baseline itself is real, measured
data**, not a guess — the meaningful improvement over this document's Day 1 version.
