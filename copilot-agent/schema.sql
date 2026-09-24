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

-- Week 2 (multimodal evidence agent): this is the source of truth for "was this document
-- ingested and what came of it" — deliberately not OpenEMR, because OpenEMR's own document
-- read API cannot reliably confirm what it stored in this fork (see openemr-documents.ts for
-- the traced bug). openemr_upload_ok records whether the best-effort OpenEMR write succeeded,
-- purely informational — nothing downstream depends on it.
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,
  openemr_user TEXT NOT NULL,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('lab_pdf', 'intake_form')),
  file_name TEXT NOT NULL,
  openemr_upload_ok INTEGER NOT NULL DEFAULT 0,
  extraction_confidence TEXT CHECK (extraction_confidence IN ('high', 'medium', 'low')),
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per extracted, cited fact — the citation contract (source_type, source_id,
-- page_or_section, field_or_chunk_id, quote_or_value) stored exactly as the model produced it,
-- so a UI can show "click to source" without re-deriving anything.
CREATE TABLE IF NOT EXISTS document_facts (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  fact_json TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  page_or_section TEXT NOT NULL,
  field_or_chunk_id TEXT NOT NULL,
  quote_or_value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_patient ON documents(patient_id);
CREATE INDEX IF NOT EXISTS idx_document_facts_document ON document_facts(document_id);

-- Week 2 RAG: guideline corpus for the evidence_retriever worker. guideline_chunks is the
-- canonical row (with its embedding cached as JSON, computed lazily on first retrieval);
-- guideline_fts is the sparse index over the same text. Seeded from corpus/guidelines.json by
-- scripts/seed-corpus.mjs. At this corpus size (~14 chunks) cosine similarity is computed in the
-- Worker; a vector database (Vectorize) only earns its place at orders of magnitude more chunks.
CREATE TABLE IF NOT EXISTS guideline_chunks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  section TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS guideline_fts USING fts5(id UNINDEXED, source, section, text);
