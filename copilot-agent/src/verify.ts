import type { AgentAnswer, PatientChart } from './types';

// Flattens the chart into field-path -> text, e.g. "medications[0]" -> "lisinopril 10mg, active".
// This is the ground truth the model's citations are checked against.
export function flattenChart(chart: PatientChart): Record<string, string> {
	const fields: Record<string, string> = {
		'patient.name': chart.patientName,
		'patient.birthDate': chart.birthDate ?? '',
	};
	chart.conditions.forEach((c, i) => {
		fields[`conditions[${i}]`] = `${c.text} (${c.status}, recorded ${c.recordedDate ?? 'unknown date'})`;
	});
	chart.medications.forEach((m, i) => {
		fields[`medications[${i}]`] = `${m.text} (${m.status}, started ${m.authoredOn ?? 'unknown date'})`;
	});
	chart.recentObservations.forEach((o, i) => {
		fields[`recentObservations[${i}]`] = `${o.text}: ${o.value} (${o.effectiveDate ?? 'unknown date'})`;
	});
	return fields;
}

export interface VerificationResult {
	status: 'verified' | 'degraded' | 'blocked';
	droppedClaims: string[];
}

// Source attribution check: every citation the model made must point at a
// field path that actually exists in the fetched chart data. This catches
// fabricated field references outright. It does NOT verify that the model's
// prose claim is a faithful paraphrase of that field's value — that would
// need a second LLM-as-judge pass, which is a known limitation documented in
// ARCHITECTURE.md, not solved here.
export function verifyAnswer(answer: AgentAnswer, chart: PatientChart): VerificationResult {
	const fields = flattenChart(chart);
	const droppedClaims: string[] = [];

	answer.citations = answer.citations.filter((c) => {
		const exists = Object.prototype.hasOwnProperty.call(fields, c.source_field);
		if (!exists) droppedClaims.push(c.claim);
		return exists;
	});

	if (droppedClaims.length === 0) {
		return { status: answer.citations.length > 0 ? 'verified' : 'degraded', droppedClaims };
	}
	// Some claims cited a field that doesn't exist in this patient's chart —
	// degrade rather than silently drop, so the caller knows the response was
	// pared back, per the "graceful degradation, transparent errors" requirement.
	return { status: 'degraded', droppedClaims };
}
