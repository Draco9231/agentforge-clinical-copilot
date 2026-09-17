import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyAnswer, flattenChart } from './verify.ts';
import type { AgentAnswer, PatientChart } from './types.ts';

const emptyChart: PatientChart = {
	patientId: '1',
	patientName: 'Test Patient',
	birthDate: null,
	conditions: [],
	medications: [],
	recentObservations: [],
};

const populatedChart: PatientChart = {
	patientId: '2',
	patientName: 'Jane Doe',
	birthDate: '1980-01-01',
	conditions: [{ text: 'Hypertension', status: 'active', recordedDate: '2024-01-01' }],
	medications: [{ text: 'Lisinopril 10mg', status: 'active', authoredOn: '2024-01-02' }],
	recentObservations: [{ text: 'Blood pressure', value: '130/85', effectiveDate: '2026-09-01' }],
};

// Invariant: a citation pointing at a field that actually exists survives verification
// and the response is marked verified. Guards against verification being so strict it
// rejects legitimate, well-grounded answers.
test('verified: citation pointing at a real field survives', () => {
	const answer: AgentAnswer = {
		summary: 'Patient is on Lisinopril for hypertension.',
		citations: [{ claim: 'on Lisinopril', source_field: 'medications[0]' }],
		uncertain_about: [],
	};
	const result = verifyAnswer(answer, populatedChart);
	assert.equal(result.status, 'verified');
	assert.equal(result.droppedClaims.length, 0);
});

// Invariant: claims must always cite a source that exists. A fabricated field reference
// must never pass through as "verified" — this is the core anti-hallucination guarantee.
test('degraded: citation pointing at a nonexistent field is dropped, not trusted', () => {
	const answer: AgentAnswer = {
		summary: 'Patient is allergic to penicillin.',
		citations: [{ claim: 'allergic to penicillin', source_field: 'allergies[0]' }],
		uncertain_about: [],
	};
	const result = verifyAnswer(answer, populatedChart);
	assert.equal(result.status, 'degraded');
	assert.deepEqual(result.droppedClaims, ['allergic to penicillin']);
	assert.equal(answer.citations.length, 0, 'the fabricated citation must be stripped from the answer, not just flagged');
});

// Boundary: an empty patient record (no conditions/meds/observations on file) must not
// crash flattening or verification, and a response with zero claims about an empty chart
// is 'degraded' (not falsely 'verified') since there's nothing to have verified.
test('boundary: empty patient record does not crash and yields degraded for a claim-free answer', () => {
	const answer: AgentAnswer = {
		summary: 'No active conditions, medications, or recent observations are on file for this patient.',
		citations: [],
		uncertain_about: [],
	};
	const result = verifyAnswer(answer, emptyChart);
	assert.equal(result.status, 'degraded');
	assert.equal(result.droppedClaims.length, 0);
});

// Boundary: malformed/empty source_field must be treated as nonexistent, not throw.
test('boundary: empty-string source_field is treated as missing, not a crash', () => {
	const answer: AgentAnswer = {
		summary: 'Something.',
		citations: [{ claim: 'something', source_field: '' }],
		uncertain_about: [],
	};
	const result = verifyAnswer(answer, populatedChart);
	assert.equal(result.status, 'degraded');
	assert.deepEqual(result.droppedClaims, ['something']);
});

// Regression guard: flattenChart's field keys are the verification contract. If the key
// naming convention (e.g. "medications[0]") ever changes without updating this test, every
// citation the model was ever trained/prompted to produce silently stops verifying.
test('regression: flattenChart field-key format stays stable', () => {
	const fields = flattenChart(populatedChart);
	assert.ok('medications[0]' in fields, 'expected medications[0] key format');
	assert.ok('conditions[0]' in fields, 'expected conditions[0] key format');
	assert.ok('recentObservations[0]' in fields, 'expected recentObservations[0] key format');
	assert.match(fields['medications[0]'], /Lisinopril/);
});
