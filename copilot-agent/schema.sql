-- Clinical Co-Pilot agent's own data (never PHI beyond what's needed to trace a request).
-- OpenEMR remains the system of record for patient data; this DB only stores
-- conversation state, tool-call/observability logs, and verification outcomes.

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  openemr_user TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  correlation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  verification_status TEXT CHECK (verification_status IN ('verified', 'degraded', 'blocked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per step of an agent invocation: tool calls, LLM calls, verification checks.
-- correlation_id ties every row for a single /api/chat request together, and every
-- log line the Worker emits to console (visible in `wrangler tail` / Cloudflare
-- Logpush) also carries the same correlation_id.
CREATE TABLE IF NOT EXISTS agent_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  correlation_id TEXT NOT NULL,
  step TEXT NOT NULL,           -- e.g. 'tool:get_patient_chart', 'llm:call', 'verify'
  status TEXT NOT NULL,         -- 'ok' | 'error' | 'degraded'
  latency_ms INTEGER,
  detail TEXT,                  -- short JSON blob, never raw PHI
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_logs_correlation ON agent_logs(correlation_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
