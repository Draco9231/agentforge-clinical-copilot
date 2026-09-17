import type { Env, PatientChart } from './types';

// The agent never holds its own elevated credential for reading patient data.
// Every call here is made with the clinician's own OpenEMR OAuth bearer token,
// forwarded as-is, so OpenEMR's existing per-user authorization (physician /
// nurse / resident scopes) is the actual access-control boundary — not
// something reimplemented in this Worker. An invalid or insufficiently-scoped
// token fails here exactly as it would against OpenEMR directly (401/403),
// and that status is passed straight back to the caller.
export class OpenEmrAuthError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}

function fhirBase(env: Env): string {
	return `${env.OPENEMR_BASE_URL}/apis/${env.OPENEMR_API_SITE}/fhir`;
}

async function fhirGet(env: Env, token: string, path: string): Promise<any> {
	const res = await fetch(`${fhirBase(env)}${path}`, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/fhir+json',
		},
	});
	if (res.status === 401 || res.status === 403) {
		throw new OpenEmrAuthError(res.status, `OpenEMR denied access to ${path}`);
	}
	if (!res.ok) {
		throw new Error(`OpenEMR FHIR request failed (${res.status}) for ${path}`);
	}
	return res.json();
}

function bundleEntries(bundle: any): any[] {
	return Array.isArray(bundle?.entry) ? bundle.entry.map((e: any) => e.resource) : [];
}

// Fetches just enough of the chart for a "what's changed / what's on file"
// summary: demographics, active problems, current meds, recent vitals/labs.
// Deliberately narrow — this traces to the one use case USERS.md defines for
// today's shell. Broader chart access is a later-stage capability, not a
// bigger fetch bolted on here.
export async function fetchPatientChart(env: Env, token: string, patientId: string): Promise<PatientChart> {
	const [patient, conditions, medications, observations] = await Promise.all([
		fhirGet(env, token, `/Patient/${patientId}`),
		// Not filtered server-side by clinical-status: OpenEMR's FHIR server does not
		// match the bare token form (`clinical-status=active`) reliably against
		// Condition.clinicalStatus, unlike MedicationRequest's `status` parameter which
		// does. Status is still surfaced per-condition in the mapped output below, so
		// the model (and verification layer) sees it either way.
		fhirGet(env, token, `/Condition?patient=${patientId}`),
		fhirGet(env, token, `/MedicationRequest?patient=${patientId}&status=active`),
		fhirGet(env, token, `/Observation?patient=${patientId}&_sort=-date&_count=10`),
	]);

	const name = patient?.name?.[0];
	const patientName = name ? [name.given?.join(' '), name.family].filter(Boolean).join(' ') : 'Unknown';

	return {
		patientId,
		patientName,
		birthDate: patient?.birthDate ?? null,
		conditions: bundleEntries(conditions).map((c: any) => ({
			text: c.code?.text ?? c.code?.coding?.[0]?.display ?? 'Unspecified condition',
			status: c.clinicalStatus?.coding?.[0]?.code ?? 'unknown',
			recordedDate: c.recordedDate ?? null,
		})),
		medications: bundleEntries(medications).map((m: any) => ({
			text: m.medicationCodeableConcept?.text ?? m.medicationCodeableConcept?.coding?.[0]?.display ?? 'Unspecified medication',
			status: m.status ?? 'unknown',
			authoredOn: m.authoredOn ?? null,
		})),
		recentObservations: bundleEntries(observations).map((o: any) => ({
			text: o.code?.text ?? o.code?.coding?.[0]?.display ?? 'Unspecified observation',
			value: o.valueQuantity ? `${o.valueQuantity.value} ${o.valueQuantity.unit ?? ''}`.trim() : (o.valueString ?? 'n/a'),
			effectiveDate: o.effectiveDateTime ?? null,
		})),
	};
}
