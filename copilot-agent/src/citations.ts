import type { PatientChart } from './types';

// W2 PRD "Citation contract": every clinical claim in the final response must carry
// machine-readable provenance {source_type, source_id, page_or_section, field_or_chunk_id,
// quote_or_value}. The model only ever names a `source_field` key (e.g. "documentFacts[0]");
// this derives the full record from that key deterministically, from data the server already
// holds — the model never authors provenance, so it cannot invent it. Runs after verifyAnswer,
// so only citations whose field really exists are ever mapped.

export interface ContractCitation {
	source_type: 'openemr_fhir' | 'lab_pdf' | 'intake_form' | 'guideline';
	source_id: string;
	page_or_section: string;
	field_or_chunk_id: string;
	quote_or_value: string;
}

const FIELD_PATTERN = /^(patient|conditions|medications|recentObservations|documentFacts|guidelineEvidence)(?:\[(\d+)\]|\.(\w+))?$/;

const OPENEMR_RESOURCE: Record<string, string> = {
	patient: 'Patient',
	conditions: 'Condition',
	medications: 'MedicationRequest',
	recentObservations: 'Observation',
};

export function toContractCitation(chart: PatientChart, sourceField: string, flattened: Record<string, string>): ContractCitation | null {
	const m = FIELD_PATTERN.exec(sourceField);
	if (!m || !(sourceField in flattened)) return null;
	const [, group, indexStr] = m;
	const index = indexStr === undefined ? undefined : Number(indexStr);

	if (group === 'documentFacts') {
		const fact = index === undefined ? undefined : chart.documentFacts?.[index];
		if (!fact?.citation) return null;
		const c = fact.citation;
		return {
			source_type: c.source_type as ContractCitation['source_type'],
			source_id: c.source_id,
			page_or_section: c.page_or_section,
			field_or_chunk_id: c.field_or_chunk_id,
			quote_or_value: c.quote_or_value,
		};
	}

	if (group === 'guidelineEvidence') {
		const ev = index === undefined ? undefined : chart.guidelineEvidence?.[index];
		if (!ev) return null;
		return { source_type: 'guideline', source_id: ev.chunkId, page_or_section: `${ev.source} - ${ev.section}`, field_or_chunk_id: ev.chunkId, quote_or_value: ev.text };
	}

	return {
		source_type: 'openemr_fhir',
		source_id: `${OPENEMR_RESOURCE[group]}/${chart.patientId}`,
		page_or_section: OPENEMR_RESOURCE[group],
		field_or_chunk_id: sourceField,
		quote_or_value: flattened[sourceField],
	};
}
