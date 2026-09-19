# Alert Definitions

Four alerts, each tied to a metric already defined in `KEY_METRICS.md` and computable from the
existing `agent_logs`/`messages` tables in D1 (`schema.sql`) — no new instrumentation needed,
only queries and thresholds. **Wiring these into an actual paging channel (Cloudflare Analytics
Engine + a scheduled Worker, or piping `agent_logs` to a real alerting tool) is follow-up work,
not done today** — what's here are the definitions: what to watch, over what window, at what
threshold, and what to do about it. The thresholds below are anchored to the real baseline
numbers from `EVAL_DATASET.md`'s Layer 3 load tests, not guesses.

## 1. Tool/dependency failure rate spike

**Metric:** KEY_METRICS.md #4 (tool/dependency failure rate).

**Query:**
```sql
SELECT
  COUNT(*) FILTER (WHERE status = 'error') * 1.0 / COUNT(*) AS error_rate,
  COUNT(*) AS sample_size
FROM agent_logs
WHERE step IN ('tool:get_patient_chart', 'llm:call')
  AND created_at > datetime('now', '-5 minutes');
```

**Threshold:** `error_rate > 0.05` (5%) with `sample_size >= 10` (guards against noise at low
traffic — a single failure out of 2 requests is not a spike). Today's live-tested baseline after
this session's fixes is 0% at both 10 and 50 concurrent, so 5% is real headroom above known-good,
not an arbitrary round number.

**Action:** Check `/ready` first to see which dependency (`d1`, `openemr`,
`anthropic_key_present`) is failing before assuming the agent itself regressed — this alert
can't distinguish "our bug" from "OpenEMR or Anthropic is down" without that follow-up look.

## 2. p95 latency SLO breach

**Metric:** KEY_METRICS.md #3 (end-to-end response latency).

**Query:** D1/SQLite has no native percentile function, so this needs an application-level
computation (a small scheduled Worker or `scripts/load-test.mjs`-style script), not a single raw
SQL query — pull `latency_ms` for `step = 'llm:call'` (the dominant phase, per EVAL_DATASET.md)
over the trailing window, sort, and take the value at the 95th-percentile index.

**Threshold:** p95 > 20 seconds, sustained across 3 consecutive 5-minute windows (not a single
spike — one slow request shouldn't page anyone). This session's live 50-concurrent load test
measured p95 ≈ 12.6s and p99 ≈ 14.5s as the known-good baseline; 20s gives real headroom above
that rather than an arbitrary number.

**Action:** Break down by step (`tool:get_patient_chart` vs `llm:call` vs `verify`) to isolate
which phase regressed before escalating — they have very different likely causes (OpenEMR/Railway
vs Anthropic API vs a bug in our own verification code).

## 3. Verification degradation rate

**Metric:** KEY_METRICS.md #1 (verification pass rate) — the single most safety-critical metric
in this project, per that doc's own framing.

**Query:**
```sql
SELECT
  COUNT(*) FILTER (WHERE verification_status != 'verified') * 1.0 / COUNT(*) AS degraded_rate,
  COUNT(*) AS sample_size
FROM messages
WHERE role = 'assistant'
  AND created_at > datetime('now', '-15 minutes');
```

**Threshold:** `degraded_rate > 0.15` (15%) with `sample_size >= 5`. A rolling 15-minute window
(longer than the failure-rate alert above) because a single conversation naturally produces some
`degraded` responses when a physician asks about something genuinely not in the chart — that's
correct behavior (see EVAL_DATASET.md's ambiguous-query test), not a bug, so this alert needs more
samples before it's meaningful.

**Action:** A sustained spike here is a different kind of problem than #1 or #2 — it means the
model is producing responses but citing things that don't survive `verifyAnswer()`, which points
at a prompt regression or a `flattenChart()` field-key format change (see the regression test in
`verify.test.ts` for exactly this contract) rather than an infrastructure failure.

## 4. Authorization denial rate anomaly

**Metric:** KEY_METRICS.md #5 (authorization denial rate) — explicitly called out there as "should
be watched, not just minimized," since both a spike *and* a suspiciously sustained zero are
signals worth investigating, not just the spike.

**Query:**
```sql
SELECT COUNT(*) AS denial_count
FROM agent_logs
WHERE step = 'tool:get_patient_chart'
  AND status = 'error'
  AND detail LIKE '%"reason":"auth"%'
  AND created_at > datetime('now', '-1 hour');
```

**Threshold:** two-sided —
- **High side:** `denial_count > 10` in an hour, which given today's traffic patterns is well
  above organic use and more consistent with credential probing or a broken OAuth scope after an
  OpenEMR config change.
- **Low side:** `denial_count = 0` sustained over a long period (e.g. a full week) *while overall
  request volume is non-trivial* — per KEY_METRICS.md's own reasoning, that's not necessarily
  good news; it can mean nobody's exercising the access-control boundary, or that it's silently
  not being enforced.

**Action:** High side → check for a single source pattern (today's logs don't capture caller
identity beyond the token itself, which is itself a gap worth closing before this alert is fully
actionable — see follow-up note below). Low side → manually attempt an out-of-scope request to
confirm authorization is actually still being enforced, not just quiet.

## Known gap in alert #4

`agent_logs` doesn't currently record *which* OpenEMR user a denied request came from (only that
one was denied) — the physician's identity lives in the OAuth token, which the Worker forwards
but doesn't decode or log today. Tightening alert #4 to distinguish "one user repeatedly denied"
from "many different users each denied once" needs that field added first. Flagged here rather
than silently left as a blind spot.
