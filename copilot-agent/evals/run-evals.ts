// Eval gate. Runs every case in golden.json against the real src/ modules, computes a boolean
// pass rate per rubric category, and exits non-zero if the build should be blocked:
//   - any category's pass rate drops below PASS_THRESHOLD, or
//   - any category regressed more than MAX_REGRESSION vs evals/baseline.json, or
//   - a case throws (a crashing case is a failure, never a skip).
// Wired to a git pre-push hook (.githooks/pre-push) — see W2_ARCHITECTURE.md.
//
// Run:  npm run eval            (gate)
//       npm run eval -- --update-baseline   (record current rates as the new baseline)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { labPdfExtractionSchema, agentAnswerSchema, chatRequestSchema } from '../src/schemas.ts';
import { verifyAnswer, flattenChart } from '../src/verify.ts';
import { sanitizeLogDetail } from '../src/logging.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CATEGORIES = ['schema_valid', 'citation_present', 'factually_consistent', 'safe_refusal', 'no_phi_in_logs'] as const;
const PASS_THRESHOLD = 0.95;
const MAX_REGRESSION = 0.05;

const golden = JSON.parse(readFileSync(join(here, 'golden.json'), 'utf8'));
const baselinePath = join(here, 'baseline.json');

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function setPath(obj: any, path: string, value: unknown) {
	const parts = path.split('.');
	let cur = obj;
	for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
	cur[parts[parts.length - 1]] = value;
}
function deletePath(obj: any, path: string) {
	const parts = path.split('.');
	let cur = obj;
	for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
	delete cur[parts[parts.length - 1]];
}

const SCHEMAS: Record<string, { safeParse: (x: unknown) => { success: boolean } }> = {
	labPdfExtraction: labPdfExtractionSchema,
	agentAnswer: agentAnswerSchema,
	chatRequest: chatRequestSchema,
};

function runCase(c: any): { pass: boolean; detail: string } {
	switch (c.kind) {
		case 'schema': {
			const input = c.inline ? clone(c.inline) : clone(golden.fixtures[c.fixture]);
			for (const p of c.mutate?.delete ? [c.mutate.delete] : []) deletePath(input, p);
			for (const [p, v] of Object.entries(c.mutate?.set ?? {})) setPath(input, p, v);
			const ok = SCHEMAS[c.schema].safeParse(input).success;
			return { pass: ok === c.expectValid, detail: `valid=${ok}, expected ${c.expectValid}` };
		}
		case 'verify': {
			const chart = clone(golden.fixtures[c.fixture]);
			const answer = clone(c.answer);
			const result = verifyAnswer(answer, chart);
			const problems: string[] = [];
			if (result.status !== c.expectStatus) problems.push(`status=${result.status}, expected ${c.expectStatus}`);
			if (result.droppedClaims.length !== c.expectDropped) problems.push(`dropped=${result.droppedClaims.length}, expected ${c.expectDropped}`);
			if (c.expectSurviving !== undefined && answer.citations.length !== c.expectSurviving) {
				problems.push(`surviving=${answer.citations.length}, expected ${c.expectSurviving}`);
			}
			return { pass: problems.length === 0, detail: problems.join('; ') || 'ok' };
		}
		case 'flatten': {
			const fields = flattenChart(clone(golden.fixtures[c.fixture]));
			const problems: string[] = [];
			for (const [key, substr] of Object.entries(c.expectContains ?? {})) {
				if (!(fields[key] ?? '').includes(substr as string)) problems.push(`${key} missing "${substr}"`);
			}
			if (c.expectNoKeyPrefix && Object.keys(fields).some((k) => k.startsWith(c.expectNoKeyPrefix))) {
				problems.push(`unexpected ${c.expectNoKeyPrefix}* keys`);
			}
			return { pass: problems.length === 0, detail: problems.join('; ') || 'ok' };
		}
		case 'redact': {
			const out = sanitizeLogDetail(clone(c.detail));
			const serialized = JSON.stringify(out);
			const problems: string[] = [];
			for (const f of c.forbidden ?? []) if (serialized.includes(f)) problems.push(`leaked "${f}"`);
			for (const k of c.requiredKeys ?? []) if (!serialized.includes(`"${k}"`)) problems.push(`lost required key ${k}`);
			if (c.maxStringLength) {
				const longest = Math.max(0, ...(serialized.match(/"[^"]*"/g) ?? []).map((s) => s.length - 2));
				if (longest > c.maxStringLength) problems.push(`string of ${longest} chars survived (max ${c.maxStringLength})`);
			}
			return { pass: problems.length === 0, detail: problems.join('; ') || 'ok' };
		}
		default:
			return { pass: false, detail: `unknown case kind ${c.kind}` };
	}
}

const results: { id: string; category: string; pass: boolean; detail: string; guards: string }[] = [];
for (const c of golden.cases) {
	let r: { pass: boolean; detail: string };
	try {
		r = runCase(c);
	} catch (e) {
		r = { pass: false, detail: `threw: ${String(e).slice(0, 120)}` };
	}
	results.push({ id: c.id, category: c.category, pass: r.pass, detail: r.detail, guards: c.guards });
}

const rates: Record<string, number> = {};
for (const cat of CATEGORIES) {
	const rows = results.filter((r) => r.category === cat);
	rates[cat] = rows.length ? rows.filter((r) => r.pass).length / rows.length : 0;
}

const baseline: Record<string, number> | null = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')).rates : null;
if (process.argv.includes('--update-baseline')) {
	writeFileSync(baselinePath, JSON.stringify({ rates, cases: results.length }, null, 2) + '\n');
	console.log('baseline updated');
}

console.log(`\nEval gate — ${results.length} cases\n`);
console.log('category               pass   rate    baseline  status');
let failed = false;
for (const cat of CATEGORIES) {
	const rows = results.filter((r) => r.category === cat);
	const passN = rows.filter((r) => r.pass).length;
	const base = baseline?.[cat];
	const reasons: string[] = [];
	if (rates[cat] < PASS_THRESHOLD) reasons.push(`below ${PASS_THRESHOLD * 100}% threshold`);
	if (base !== undefined && rates[cat] < base - MAX_REGRESSION) reasons.push(`regressed >${MAX_REGRESSION * 100}% from baseline`);
	if (reasons.length) failed = true;
	console.log(
		`${cat.padEnd(22)} ${`${passN}/${rows.length}`.padEnd(6)} ${(rates[cat] * 100).toFixed(0).padStart(3)}%    ${
			base === undefined ? '  -  ' : `${(base * 100).toFixed(0)}%`.padStart(4)
		}     ${reasons.length ? 'FAIL: ' + reasons.join(', ') : 'ok'}`,
	);
}

const failing = results.filter((r) => !r.pass);
if (failing.length) {
	console.log('\nFailing cases:');
	for (const f of failing) console.log(`  ${f.id} [${f.category}] ${f.detail}\n      guards: ${f.guards}`);
}

writeFileSync(join(here, 'latest-results.json'), JSON.stringify({ rates, results }, null, 2) + '\n');
if (failed) {
	console.log('\nEVAL GATE FAILED — push blocked.');
	process.exit(1);
}
console.log('\nEval gate passed.');
