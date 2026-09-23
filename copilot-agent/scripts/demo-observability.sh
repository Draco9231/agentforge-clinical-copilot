#!/usr/bin/env bash
# Demo helper: shows cost, per-step latency, and a traceable request from the live D1 agent_logs.
# Run from anywhere: bash copilot-agent/scripts/demo-observability.sh
set -euo pipefail
cd "$(dirname "$0")/.."

q() {
  npx wrangler d1 execute clinical-copilot-db --remote --json --command "$1" 2>/dev/null | python3 -c "
import sys, json
rows = json.load(sys.stdin)[0]['results']
if not rows:
    print('  (no rows)'); sys.exit()
cols = list(rows[0].keys())
w = {c: max(len(c), *(len(str(r[c])) for r in rows)) for c in cols}
print('  ' + '  '.join(c.ljust(w[c]) for c in cols))
print('  ' + '  '.join('-' * w[c] for c in cols))
for r in rows:
    print('  ' + '  '.join(str(r[c]).ljust(w[c]) for c in cols))
"
}

echo
echo "1) COST PER QUESTION  (2 model calls each: answer + faithfulness check; tokens from Anthropic's usage field)"
q "SELECT substr(correlation_id,1,8) AS request, COUNT(*) AS model_calls, SUM(json_extract(detail,'\$.inputTokens')) AS in_tok, SUM(json_extract(detail,'\$.outputTokens')) AS out_tok, ROUND(SUM(json_extract(detail,'\$.estimatedCostUsd')),4) AS usd, SUM(latency_ms) AS total_ms FROM agent_logs WHERE step IN ('llm:call','verify:judge') AND json_extract(detail,'\$.estimatedCostUsd') IS NOT NULL GROUP BY correlation_id ORDER BY MAX(id) DESC LIMIT 4"

echo
echo "2) WHERE THE TIME GOES  (average latency and error count per step, all requests)"
q "SELECT step, COUNT(*) AS calls, ROUND(AVG(latency_ms)) AS avg_ms, SUM(status='error') AS errors FROM agent_logs GROUP BY step ORDER BY calls DESC"

echo
echo "3) ONE REQUEST, END TO END  (same correlation ID appears in Langfuse as the trace ID)"
q "SELECT substr(correlation_id,1,8) AS request, step, status, latency_ms FROM agent_logs WHERE correlation_id = (SELECT correlation_id FROM agent_logs WHERE step = 'llm:call' ORDER BY id DESC LIMIT 1) ORDER BY id"
echo
