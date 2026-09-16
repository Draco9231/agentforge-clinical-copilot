# Key Metrics

These are the numbers that would tell a hospital CTO whether the Clinical Co-Pilot is actually
doing its job — not just "is it up," but "is it safe and useful enough that a physician would
keep choosing it over flipping through tabs themselves."

## 1. Verification pass rate (`verified` vs `degraded` vs `blocked`)

**What it is:** the percentage of `/api/chat` responses that come back fully `verified` (every
claim traced to a real chart field) vs. `degraded` (some claim's citation didn't check out) vs.
`blocked` (response withheld entirely).

**Why it's the top metric:** this is a direct, continuously-measured proxy for the single risk
that matters most in this domain — a confidently stated hallucination. Every other metric is
about whether the product is worth using; this one is about whether it's *safe* to use at all.
A hospital CTO's first question would be "how do you know it's not making things up," and this
metric is the honest, always-on answer, not a one-time eval score.

**How we show it's true:** every response the agent produces is verified before it's shown, and
the verification outcome is stored per-message in D1 (`messages.verification_status`) and
per-step in `agent_logs`. Nothing about this metric requires trusting the model's own self-report.

## 2. Source-citation coverage (citations per response, and % of claims backed)

**What it is:** average number of citations per response, and the fraction of the model's
stated claims that survived verification (weren't dropped as pointing at a nonexistent field).

**Why it matters:** "verified" as a binary hides a lot. A response with one shaky citation
dropped out of ten is a very different failure than one where half the claims were fabricated.
This metric is what turns "is it safe" into "how close to the edge is it running."

## 3. End-to-end response latency (p50 / p95)

**What it is:** wall-clock time from `/api/chat` request to response, broken into the three
measured phases (`tool:get_patient_chart`, `llm:call`, `verify`) via `agent_logs.latency_ms`.

**Why it matters:** the entire premise of the product (per the case study) is a 90-second window
between patient rooms. If p95 latency creeps past what a physician will tolerate mid-workflow,
the product fails on its core value proposition regardless of how accurate it is — accuracy and
speed are both non-negotiable, not a tradeoff to pick one side of silently.

## 4. Tool/dependency failure rate

**What it is:** the fraction of requests where `tool:get_patient_chart` or `llm:call` logged
`status: error` in `agent_logs`, broken out by failure type (OpenEMR auth denial vs. OpenEMR
unreachable vs. Anthropic API error).

**Why it matters:** distinguishes "the agent is unsafe" (verification failures) from "the agent
is unreliable" (infrastructure failures) — two different engineering problems with different
fixes. It's also the direct input to the alert thresholds required by the engineering spec.

## 5. Authorization denial rate (401/403 from OpenEMR, surfaced not swallowed)

**What it is:** how often a chat request is denied because the physician's own OpenEMR token
doesn't have access to the requested patient.

**Why it matters:** this is the metric that proves the "no shared elevated credential" design
decision in ARCHITECTURE.md is actually load-bearing and not just documentation. A rate of
exactly zero over time would be suspicious (either nobody's testing access boundaries, or
authorization is silently being bypassed) — this number should be watched, not just minimized.

## Deferred (documented, not measured yet)

- **Time-to-first-useful-answer** from the physician's perspective (requires session/UX
  instrumentation beyond today's shell).
- **Adoption / retention** (would need real physician usage, not applicable to a synthetic-data
  demo).
- **Cost per query** (tokens × price) — tracked in `AI_COST_ANALYSIS.md`, not duplicated here
  since it's a cost metric, not a success metric.
