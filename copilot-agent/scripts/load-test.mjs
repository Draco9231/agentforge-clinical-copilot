#!/usr/bin/env node
// Load test for POST /api/chat against the live deployment. Run with:
//   BASE_URL=... OPENEMR_ADMIN_PASSWORD=... PATIENT_ID=... node scripts/load-test.mjs [concurrency]
//
// Captures p50/p95/p99 latency and error rate, per the engineering requirement to load-test at
// 10 and 50 concurrent users. Uses the admin login (the only account available) as the bearer
// token source — this measures the agent's own performance ceiling, not per-role access control,
// which is a separate, already-documented test (see EVAL_DATASET.md).

const BASE_URL = process.env.BASE_URL ?? 'https://clinical-copilot-agent.genesysx.workers.dev';
const USERNAME = process.env.OPENEMR_ADMIN_USERNAME ?? 'admin';
const PASSWORD = process.env.OPENEMR_ADMIN_PASSWORD;
const PATIENT_ID = process.env.PATIENT_ID;
const CONCURRENCY = Number(process.argv[2] ?? 10);

const QUESTIONS = [
	"What's currently active for this patient?",
	'Is she on anything that would interact with ibuprofen?',
	"What's changed since her last visit?",
	'Summarize her recent labs.',
];

function percentile(sorted, p) {
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx];
}

async function login() {
	const res = await fetch(`${BASE_URL}/api/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
	});
	if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
	const { access_token } = await res.json();
	return access_token;
}

async function oneRequest(token) {
	const start = Date.now();
	try {
		const res = await fetch(`${BASE_URL}/api/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				patientId: PATIENT_ID,
				message: QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)],
			}),
		});
		const latencyMs = Date.now() - start;
		const body = await res.json().catch(() => ({}));
		return { ok: res.ok, status: res.status, latencyMs, correlationId: body.correlationId };
	} catch (e) {
		return { ok: false, status: 0, latencyMs: Date.now() - start, error: String(e) };
	}
}

async function runWave(token, concurrency) {
	const results = await Promise.all(Array.from({ length: concurrency }, () => oneRequest(token)));
	const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
	const errors = results.filter((r) => !r.ok);
	return {
		concurrency,
		count: results.length,
		errorCount: errors.length,
		errorRate: errors.length / results.length,
		p50: percentile(latencies, 50),
		p95: percentile(latencies, 95),
		p99: percentile(latencies, 99),
		min: latencies[0],
		max: latencies[latencies.length - 1],
	};
}

async function main() {
	if (!PASSWORD) throw new Error('Set OPENEMR_ADMIN_PASSWORD');
	if (!PATIENT_ID) throw new Error('Set PATIENT_ID');
	console.log(`Logging in as ${USERNAME}...`);
	const token = await login();
	console.log(`Running ${CONCURRENCY} concurrent requests against ${BASE_URL}/api/chat...`);
	const result = await runWave(token, CONCURRENCY);
	console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
