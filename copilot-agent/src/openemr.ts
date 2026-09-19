import type { Env, PatientChart } from './types';

// The agent never holds its own elevated credential for reading patient data.
// Every call here is made with the clinician's own OpenEMR OAuth bearer token,
// forwarded as-is, so OpenEMR's existing per-user authorization (physician /
// nurse / resident scopes) is the actual access-control boundary — not
// something reimplemented in this Worker. An invalid or insufficiently-scoped
// token fails here exactly as it would against OpenEMR directly (401/403),
// and that status is passed straight back to the caller.
export class OpenEmrAuthError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
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

// Confirmed live against a real multi-vital encounter (2026-09-18): OpenEMR's FHIR server
// represents one vitals-form save as a *panel* Observation (LOINC 85353-1) whose `hasMember`
// references point at ~10 individual child Observations (temp, pulse, resp rate, height,
// weight, BMI, blood pressure, ...) — not one Observation with everything in `component[]`.
// The panel itself carries no value of its own (`observationValue()` on it is always 'n/a'),
// so at `_count=10` it silently occupies a slot that would otherwise hold a real reading —
// concretely, this dropped blood pressure (last in the hasMember list) from the chart entirely,
// which the agent then correctly reported as "not available" rather than guessing, but that's
// masking a real fetch bug, not the intended failure mode. Filtering panels out here (they're
// pure noise for a flattened chart) and fetching a wider window recovers the real readings.
export function isPanelObservation(o: any): boolean {
	return Array.isArray(o.hasMember) && o.hasMember.length > 0;
}

function quantityText(q: any): string {
	return `${q.value} ${q.unit ?? ''}`.trim();
}

// Confirmed live (see ARCHITECTURE.md's known limitations): a component-based panel (e.g. a
// single blood-pressure Observation with separate systolic/diastolic under `component[]`, no
// top-level valueQuantity) previously surfaced as "n/a" even though the reading was on file —
// the agent correctly refused to guess, but that's a real parsing gap, not the intended failure
// mode. Falls back through valueQuantity -> valueString -> component[] -> 'n/a', in that order.
export function observationValue(o: any): string {
	if (o.valueQuantity) return quantityText(o.valueQuantity);
	if (typeof o.valueString === 'string') return o.valueString;
	if (Array.isArray(o.component) && o.component.length > 0) {
		const parts = o.component.map((c: any) => {
			const label = c.code?.text ?? c.code?.coding?.[0]?.display ?? 'component';
			const value = c.valueQuantity ? quantityText(c.valueQuantity) : (c.valueString ?? 'n/a');
			return `${label}: ${value}`;
		});
		return parts.join(', ');
	}
	return 'n/a';
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
		// _count=30 (not 10): confirmed live (2026-09-18) that a single vitals-form encounter
		// produces 1 panel + 15 leaf children (temp, pulse, resp rate, both O2 sat variants,
		// height, weight, BMI, blood pressure, plus several pediatric-oriented percentile/
		// weight-for-length rows OpenEMR generates regardless of patient age) — 16 rows for one
		// visit. 10 wasn't enough to cover one visit's own vitals; 30 leaves headroom for a
		// second encounter without ballooning the LLM's context on every request.
		fhirGet(env, token, `/Observation?patient=${patientId}&_sort=-date&_count=30`),
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
		recentObservations: bundleEntries(observations)
			.filter((o: any) => !isPanelObservation(o))
			// 15, not 10: one encounter's own vitals leaves fill exactly this many slots (see the
			// comment on the Observation fetch above) — a smaller cap would silently re-introduce
			// the blood-pressure-dropping bug this fix addresses. Includes some rows that are
			// pediatric-oriented noise for an adult patient (percentile/weight-for-length); not
			// filtered further here — that's a separate, not-yet-tackled cleanup, not this bug.
			.slice(0, 15)
			.map((o: any) => ({
				text: o.code?.text ?? o.code?.coding?.[0]?.display ?? 'Unspecified observation',
				value: observationValue(o),
				effectiveDate: o.effectiveDateTime ?? null,
			})),
	};
}
