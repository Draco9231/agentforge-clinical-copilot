// Every log detail passes through here before it reaches D1, console, or Langfuse. Found
// 2026-09-24 auditing against the Week 2 rubric category `no_phi_in_logs`: index.ts was logging
// the patient identifier (tool:get_patient_chart) and the free text of dropped clinical claims
// (verify) — both PHI-bearing — to D1 and to a third-party SaaS. Fixing it once at the choke
// point (logStep) means a future logStep call can't reintroduce it by forgetting to redact.
//
// Deny-list by key, applied recursively. Free-text/identifier keys are dropped outright; claim
// lists are replaced by their count, which keeps the operational signal (how many claims were
// dropped) without the clinical content. A deny-list can't catch PHI hidden inside an arbitrary
// string value (e.g. an upstream error message) — root-level strings are therefore truncated
// rather than trusted, and that residual risk is documented in W2_ARCHITECTURE.md.
const DROP_KEYS = new Set([
	'patientid',
	'patient_id',
	'patientname',
	'patient_name',
	'name',
	'dob',
	'birthdate',
	'quote',
	'quote_or_value',
	'text',
	'value',
	'claim',
	'summary',
	'message',
	'content',
	'fact_json',
	'filename',
	'file_name',
]);

const COUNT_KEYS = new Set(['droppedclaims', 'unfaithfulclaims', 'uncertainabout']);

const MAX_STRING = 200;

export function sanitizeLogDetail(detail: unknown): unknown {
	if (detail === null || detail === undefined) return detail;
	if (typeof detail === 'string') return detail.length > MAX_STRING ? detail.slice(0, MAX_STRING) + '…' : detail;
	if (typeof detail !== 'object') return detail;
	if (Array.isArray(detail)) return detail.map(sanitizeLogDetail);

	const out: Record<string, unknown> = {};
	for (const [key, val] of Object.entries(detail as Record<string, unknown>)) {
		const lower = key.toLowerCase();
		if (DROP_KEYS.has(lower)) continue;
		if (COUNT_KEYS.has(lower)) {
			out[`${key}Count`] = Array.isArray(val) ? val.length : 0;
			continue;
		}
		out[key] = sanitizeLogDetail(val);
	}
	return out;
}
