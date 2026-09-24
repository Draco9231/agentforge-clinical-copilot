#!/usr/bin/env node
// Generates the SQL to (re)seed the guideline corpus and applies it to remote D1.
// Usage: node scripts/seed-corpus.mjs            (writes /tmp/seed-corpus.sql and runs it)
// Idempotent: clears both tables first so an edited corpus never leaves stale chunks behind, and
// nulls embeddings so they are recomputed against the new text on next retrieval.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { chunks } = JSON.parse(readFileSync(join(root, 'corpus/guidelines.json'), 'utf8'));
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const lines = ['DELETE FROM guideline_chunks;', 'DELETE FROM guideline_fts;'];
for (const c of chunks) {
	lines.push(`INSERT INTO guideline_chunks (id, source, section, text, embedding) VALUES (${q(c.id)}, ${q(c.source)}, ${q(c.section)}, ${q(c.text)}, NULL);`);
	lines.push(`INSERT INTO guideline_fts (id, source, section, text) VALUES (${q(c.id)}, ${q(c.source)}, ${q(c.section)}, ${q(c.text)});`);
}
writeFileSync('/tmp/seed-corpus.sql', lines.join('\n') + '\n');
execSync('npx wrangler d1 execute clinical-copilot-db --remote --file=/tmp/seed-corpus.sql', { cwd: root, stdio: 'inherit' });
console.log(`seeded ${chunks.length} chunks`);
