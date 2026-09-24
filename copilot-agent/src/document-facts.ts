import type { Env } from './types';
import type { IntakeFormExtraction } from './extraction';

export interface DocFactRow {
	fact_json: string;
	file_name: string;
}

type Citation = { source_type: string; source_id: string; page_or_section: string; field_or_chunk_id: string; quote_or_value: string };

// Intake extractions are stored one fact per D1 row (same shape as lab results: a JSON blob with
// its citation), so both document types flow through one loader and one citation contract.
export interface IntakeFactJson {
	category: 'demographics' | 'chief_concern' | 'medication' | 'allergy' | 'family_history';
	label: string;
	value: string | null;
	citation: Citation;
}

export function intakeToFacts(e: IntakeFormExtraction): IntakeFactJson[] {
	const facts: IntakeFactJson[] = [];
	for (const d of e.demographics) facts.push({ category: 'demographics', label: d.field, value: d.value, citation: d.citation });
	if (e.chief_concern) facts.push({ category: 'chief_concern', label: 'chief concern', value: e.chief_concern.text, citation: e.chief_concern.citation });
	for (const m of e.current_medications) {
		facts.push({ category: 'medication', label: m.name, value: [m.dose, m.frequency].filter(Boolean).join(', ') || null, citation: m.citation });
	}
	for (const a of e.allergies) facts.push({ category: 'allergy', label: a.substance, value: a.reaction ?? null, citation: a.citation });
	for (const f of e.family_history) facts.push({ category: 'family_history', label: f.condition, value: f.relative ?? null, citation: f.citation });
	return facts;
}

// Stored for completeness (it is on the form) but never put in front of the answer model: a
// physician asking about meds and labs does not need the patient's phone number or address in the
// prompt, and every field sent to a model is a field that can leak. Data minimization at the
// prompt boundary, not just at storage.
const NEVER_PROMPT = new Set(['phone', 'address', 'email']);

function intakeText(f: IntakeFactJson): string | null {
	switch (f.category) {
		case 'demographics':
			return NEVER_PROMPT.has(f.label) ? null : `Intake form demographics, ${f.label}: ${f.value}`;
		case 'chief_concern':
			return `Chief concern (patient-reported on intake form): ${f.value}`;
		case 'medication':
			return `Patient-reported current medication (intake form): ${f.label}${f.value ? ` - ${f.value}` : ''}`;
		case 'allergy':
			return `Patient-reported allergy (intake form): ${f.label}${f.value ? ` - reaction: ${f.value}` : ''}`;
		case 'family_history':
			return `Family history (intake form): ${f.label}${f.value ? ` (${f.value})` : ''}`;
	}
}

// Newest document first, deduped so re-uploading the same document doesn't multiply identical
// facts in the model's context (seen live: three uploads of one report -> 21 lines). Lab facts
// dedupe on test+date; intake facts on category+label. Pure and separately testable; the D1 query
// lives in loadDocumentFacts below.
export function dedupeFacts(rows: DocFactRow[]) {
	const seen = new Set<string>();
	const facts: { text: string; source: string; citation?: Citation }[] = [];
	for (const row of rows) {
		const r = JSON.parse(row.fact_json);
		if (r.test_name !== undefined) {
			const key = `lab|${r.test_name}|${r.collection_date ?? ''}`;
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
		} else if (r.category) {
			const key = `intake|${r.category}|${String(r.label).toLowerCase()}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const text = intakeText(r as IntakeFactJson);
			if (text) facts.push({ text, source: `uploaded ${r.citation.source_type} "${row.file_name}" p.${r.citation.page_or_section}`, citation: r.citation });
		}
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
