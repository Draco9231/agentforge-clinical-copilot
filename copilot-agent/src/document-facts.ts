import type { Env } from './types';

export interface DocFactRow {
	fact_json: string;
	file_name: string;
}

// Newest document first, deduped by test+date so re-uploading the same report doesn't multiply
// identical facts in the model's context (seen live: three uploads of one report -> 21 lines).
// Pure and separately testable; the D1 query lives in loadDocumentFacts below.
export function dedupeFacts(rows: DocFactRow[]) {
	const seen = new Set<string>();
	const facts: { text: string; source: string; citation?: { source_type: string; source_id: string; page_or_section: string; field_or_chunk_id: string; quote_or_value: string } }[] = [];
	for (const row of rows) {
		const r = JSON.parse(row.fact_json);
		const key = `${r.test_name}|${r.collection_date ?? ''}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const detail = [
			r.unit ? `${r.value} ${r.unit}` : r.value,
			r.reference_range ? `ref ${r.reference_range}` : null,
			`flag ${r.abnormal_flag}`,
			r.collection_date ? `collected ${r.collection_date}` : null,
		]
			.filter(Boolean)
			.join(', ');
		facts.push({ text: `${r.test_name}: ${detail}`, source: `uploaded ${r.citation.source_type} "${row.file_name}" p.${r.citation.page_or_section}`, citation: r.citation });
	}
	return facts;
}

export async function loadDocumentFacts(env: Env, patientId: string) {
	const rows = await env.DB.prepare(
		`SELECT f.fact_json AS fact_json, d.file_name AS file_name
		 FROM document_facts f JOIN documents d ON d.id = f.document_id
		 WHERE d.patient_id = ? ORDER BY d.created_at DESC, f.rowid ASC LIMIT 200`,
	)
		.bind(patientId)
		.all<DocFactRow>();
	return dedupeFacts(rows.results ?? []);
}

export async function countDocuments(env: Env, patientId: string): Promise<number> {
	const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM documents WHERE patient_id = ?').bind(patientId).first<{ n: number }>();
	return row?.n ?? 0;
}
