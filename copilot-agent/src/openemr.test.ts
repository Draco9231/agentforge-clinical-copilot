import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observationValue, isPanelObservation } from './openemr.ts';

// Invariant: a simple scalar Observation (most labs/vitals) still reads its value directly.
test('observationValue: reads a top-level valueQuantity', () => {
	assert.equal(observationValue({ valueQuantity: { value: 98.6, unit: 'degF' } }), '98.6 degF');
});

// Regression: this is the exact bug documented in ARCHITECTURE.md's known limitations — a
// blood-pressure-style panel with no top-level valueQuantity, only component[] entries, used to
// fall through to 'n/a' even though systolic/diastolic were both on file.
test('observationValue: reads systolic/diastolic from component[] when there is no top-level value', () => {
	const bp = {
		code: { text: 'Blood pressure' },
		component: [
			{ code: { text: 'Systolic' }, valueQuantity: { value: 120, unit: 'mmHg' } },
			{ code: { text: 'Diastolic' }, valueQuantity: { value: 80, unit: 'mmHg' } },
		],
	};
	assert.equal(observationValue(bp), 'Systolic: 120 mmHg, Diastolic: 80 mmHg');
});

// Boundary: an Observation with none of valueQuantity/valueString/component must still return a
// safe placeholder, not throw or return undefined.
test('observationValue: falls back to n/a when nothing is present', () => {
	assert.equal(observationValue({}), 'n/a');
});

// Boundary: valueString takes priority over an absent valueQuantity, and an empty string is a
// legitimate (if unusual) value, not treated as "missing".
test('observationValue: reads valueString when there is no valueQuantity', () => {
	assert.equal(observationValue({ valueString: 'trace' }), 'trace');
});

// Regression: found live (2026-09-18) creating a real multi-vital patient — OpenEMR's FHIR
// server returns a vitals-form save as a *panel* Observation with `hasMember` references to
// ~10 child Observations, not one Observation holding everything. The panel has no value of
// its own; at fetchPatientChart's old _count=10, one panel + its children could fill the whole
// budget and silently drop the actual reading (blood pressure, last in the list) before our
// mapping ever saw it. Panels must be filtered out, not mapped as 'n/a' observations.
test('isPanelObservation: identifies a grouper Observation by a non-empty hasMember', () => {
	const panel = {
		code: { coding: [{ display: 'Vital signs panel' }] },
		hasMember: [{ reference: 'Observation/abc', display: 'Blood pressure systolic and diastolic' }],
	};
	assert.equal(isPanelObservation(panel), true);
});

// Boundary: an ordinary Observation (the common case) must not be misidentified as a panel.
test('isPanelObservation: a real observation with no hasMember is not a panel', () => {
	assert.equal(isPanelObservation({ valueQuantity: { value: 98.6, unit: 'degF' } }), false);
});
