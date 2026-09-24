// Live-model eval tier (W2 PRD: extraction quality against ground truth). Unlike the offline gate
// (run-evals.ts), this calls the real Claude model on real sample PDFs, so it costs a few cents and
// needs network — run it on demand and before release, not on every push:  npm run eval:live
//
// Boolean rubrics per document, each guarding a named failure mode:
//   schema_valid        extraction parsed against the strict Zod schema (extract* throws otherwise)
//   citation_present    every extracted item carries a complete citation
//   factually_consistent every expected fact is present with the right value/flag
//   no_invention        nothing extracted that is not in the ground truth (fabricated med/allergy/lab)
//   quote_grounded      every quoted citation actually appears in the source text (the check the
//                       offline suite cannot do: the model's quote is verified against the document)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { extractLabPdf, extractIntakeForm } from '../src/extraction.ts';
import { estimateCostUsd } from '../src/cost.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vars = readFileSync(join(root, '.dev.vars'), 'utf8');
const key = /^ANTHROPIC_API_KEY=(.+)$/m.exec(vars)?.[1]?.trim().replace(/^["']|["']$/g, '');
if (!key) throw new Error('ANTHROPIC_API_KEY not found in .dev.vars');
const env = { ANTHROPIC_API_KEY: key } as any;

const expected = JSON.parse(readFileSync(join(root, 'samples/expected.json'), 'utf8'));
const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

interface Rubric { name: string; pass: boolean; detail: string }

function grade(docName: string, extraction: any): Rubric[] {
	const exp = expected[docName];
	const source = norm(readFileSync(join(root, `samples/${docName}.txt`), 'utf8'));
	const items: { label: string; value?: string; citation: any }[] = [];
	if (exp.type === 'lab_pdf') {
		for (const r of extraction.results) items.push({ label: r.test_name, value: r.value, citation: r.citation });
	} else {
		for (const m of extraction.current_medications) items.push({ label: m.name, citation: m.citation });
		for (const a of extraction.allergies) items.push({ label: a.substance, citation: a.citation });
		for (const f of extraction.family_history) items.push({ label: f.condition, citation: f.citation });
		if (extraction.chief_concern) items.push({ label: 'chief concern', citation: extraction.chief_concern.citation });
		for (const d of extraction.demographics) items.push({ label: d.field, value: d.value, citation: d.citation });
	}

	const citationOk = items.every((i) => i.citation && ['page_or_section', 'field_or_chunk_id', 'quote_or_value', 'source_id'].every((k) => String(i.citation[k] ?? '').length > 0));
	const ungrounded = items.filter((i) => !source.includes(norm(i.citation.quote_or_value)));

	const problems: string[] = [];
	let extras: string[] = [];
	if (exp.type === 'lab_pdf') {
		for (const e of exp.labs) {
			const got = extraction.results.find((r: any) => norm(r.test_name).includes(e.test));
			if (!got) problems.push(`missing ${e.test}`);
			else {
				if (norm(got.value) !== norm(e.value)) problems.push(`${e.test} value ${got.value} != ${e.value}`);
				if (got.abnormal_flag !== e.flag) problems.push(`${e.test} flag ${got.abnormal_flag} != ${e.flag}`);
			}
		}
		extras = extraction.results.filter((r: any) => !exp.labs.some((e: any) => norm(r.test_name).includes(e.test))).map((r: any) => r.test_name);
	} else {
		const has = (list: string[], names: string[]) => names.forEach((n) => { if (!list.some((x) => norm(x).includes(n))) problems.push(`missing ${n}`); });
		has(extraction.current_medications.map((m: any) => m.name), exp.medications);
		has(extraction.allergies.map((a: any) => a.substance), exp.allergies);
		has(extraction.family_history.map((f: any) => `${f.condition} ${f.relative ?? ''}`), exp.family_history);
		const cc = norm(extraction.chief_concern?.text);
		for (const w of exp.chief_concern_contains) if (!cc.includes(w)) problems.push(`chief concern missing "${w}"`);
		const dn = norm(extraction.demographics.find((d: any) => d.field === 'name')?.value);
		const dd = norm(extraction.demographics.find((d: any) => d.field === 'dob')?.value);
		if (!dn.includes(exp.demographics.name)) problems.push(`name "${dn}"`);
		if (!dd.includes(exp.demographics.dob)) problems.push(`dob "${dd}"`);
		extras = [
			...extraction.current_medications.map((m: any) => m.name).filter((n: string) => !exp.medications.some((e: string) => norm(n).includes(e))),
			...extraction.allergies.map((a: any) => a.substance).filter((n: string) => !exp.allergies.some((e: string) => norm(n).includes(e)) && !/none|no other|no known/i.test(n)),
		];
	}
	return [
		{ name: 'schema_valid', pass: true, detail: 'parsed' },
		{ name: 'citation_present', pass: citationOk, detail: citationOk ? 'ok' : 'an item has an incomplete citation' },
		{ name: 'factually_consistent', pass: problems.length === 0, detail: problems.join('; ') || 'ok' },
		{ name: 'no_invention', pass: extras.length === 0, detail: extras.length ? `extra: ${extras.join(', ')}` : 'ok' },
		{ name: 'quote_grounded', pass: ungrounded.length === 0, detail: ungrounded.length ? `quote not in source: ${ungrounded.map((u) => `"${String(u.citation.quote_or_value).slice(0, 40)}"`).join(', ')}` : 'ok' },
	];
}

let failed = false;
let totalCost = 0;
for (const docName of Object.keys(expected)) {
	const pdf = readFileSync(join(root, `samples/${docName}.pdf`)).toString('base64');
	const t = Date.now();
	let rubrics: Rubric[];
	let cost = 0;
	try {
		const r = expected[docName].type === 'lab_pdf' ? await extractLabPdf(env, pdf, 'live-eval') : await extractIntakeForm(env, pdf, 'live-eval');
		cost = estimateCostUsd(r.usage);
		rubrics = grade(docName, r.extraction);
		console.log(`  confidence: ${r.extraction.extraction_confidence}`);
	} catch (e) {
		rubrics = [{ name: 'schema_valid', pass: false, detail: `extraction failed: ${String(e).slice(0, 160)}` }];
	}
	totalCost += cost;
	console.log(`\n${docName} (${expected[docName].type})  ${((Date.now() - t) / 1000).toFixed(1)}s  $${cost.toFixed(4)}`);
	for (const r of rubrics) {
		console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(22)} ${r.detail}`);
		if (!r.pass) failed = true;
	}
}
console.log(`\ntotal cost $${totalCost.toFixed(4)}`);
if (failed) {
	console.log('LIVE EVAL FAILED');
	process.exit(1);
}
console.log('Live eval passed.');
