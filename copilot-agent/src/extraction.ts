import type { Env } from './types';
import { labPdfExtractionSchema, intakeFormExtractionSchema } from './schemas';
import type { ModelUsage } from './cost';
import type { z } from 'zod';

export type LabPdfExtraction = z.infer<typeof labPdfExtractionSchema>;
export type IntakeFormExtraction = z.infer<typeof intakeFormExtractionSchema>;

export class ExtractionError extends Error {
	usage: ModelUsage;
	constructor(message: string, usage: ModelUsage) {
		super(message);
		this.usage = usage;
	}
}

// The model supplies where it read each fact; the server supplies which document it belongs to.
// The model has no way to know our internal document id and is never asked to invent it.
const CITATION_INPUT = {
	type: 'object',
	properties: {
		page_or_section: { type: 'string', description: 'Page number this was read from, e.g. "1"' },
		field_or_chunk_id: { type: 'string', description: 'A short identifier for this field, e.g. "hemoglobin_a1c"' },
		quote_or_value: { type: 'string', description: 'The exact text as it appears in the document' },
	},
	required: ['page_or_section', 'field_or_chunk_id', 'quote_or_value'],
};

const SHARED_RULES =
	'Read only what is actually legible in the document. Every fact you report must be traceable ' +
	'to a specific page and exact quoted text — never state anything you cannot point to. If a ' +
	'field is genuinely absent or illegible, leave it null or omit the item rather than guessing; ' +
	'do not fabricate a plausible-looking value. Always respond by calling the provided tool.';

const LAB_TOOL = {
	name: 'submit_lab_extraction',
	description: 'Submit the structured lab results extracted from this PDF. Every result MUST include a citation.',
	input_schema: {
		type: 'object',
		properties: {
			results: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						test_name: { type: 'string' },
						value: { type: 'string' },
						unit: { type: ['string', 'null'] },
						reference_range: { type: ['string', 'null'] },
						collection_date: { type: ['string', 'null'], description: 'ISO 8601 date if legible' },
						abnormal_flag: { type: 'string', enum: ['normal', 'high', 'low', 'critical', 'unknown'] },
						citation: CITATION_INPUT,
					},
					required: ['test_name', 'value', 'abnormal_flag', 'citation'],
				},
			},
			extraction_confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Your honest confidence given scan quality and legibility.' },
			unparsed_notes: { type: 'array', items: { type: 'string' }, description: 'Anything you could not confidently extract.' },
		},
		required: ['results', 'extraction_confidence', 'unparsed_notes'],
	},
};

const INTAKE_TOOL = {
	name: 'submit_intake_extraction',
	description: 'Submit the structured fields extracted from this patient intake form. Every item MUST include a citation.',
	input_schema: {
		type: 'object',
		properties: {
			demographics: {
				type: 'array',
				items: {
					type: 'object',
					properties: { field: { type: 'string', enum: ['name', 'dob', 'sex', 'phone', 'address', 'email'] }, value: { type: 'string' }, citation: CITATION_INPUT },
					required: ['field', 'value', 'citation'],
				},
			},
			chief_concern: {
				type: ['object', 'null'],
				properties: { text: { type: 'string' }, citation: CITATION_INPUT },
				required: ['text', 'citation'],
			},
			current_medications: {
				type: 'array',
				items: {
					type: 'object',
					properties: { name: { type: 'string' }, dose: { type: ['string', 'null'] }, frequency: { type: ['string', 'null'] }, citation: CITATION_INPUT },
					required: ['name', 'citation'],
				},
			},
			allergies: {
				type: 'array',
				items: {
					type: 'object',
					properties: { substance: { type: 'string' }, reaction: { type: ['string', 'null'] }, citation: CITATION_INPUT },
					required: ['substance', 'citation'],
				},
			},
			family_history: {
				type: 'array',
				items: {
					type: 'object',
					properties: { condition: { type: 'string' }, relative: { type: ['string', 'null'] }, citation: CITATION_INPUT },
					required: ['condition', 'citation'],
				},
			},
			extraction_confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Your honest confidence given scan quality and legibility.' },
			unparsed_notes: { type: 'array', items: { type: 'string' }, description: 'Anything you could not confidently extract.' },
		},
		required: ['demographics', 'current_medications', 'allergies', 'family_history', 'extraction_confidence', 'unparsed_notes'],
	},
};

// Claude Sonnet 5 reads the PDF natively as a base64 document block — no separate OCR/VLM step —
// and the extraction is taken from a forced tool call, then validated against a strict Zod schema
// before anything downstream sees it.
async function callForcedTool(env: Env, pdfBase64: string, system: string, tool: { name: string }, prompt: string): Promise<{ input: any; usage: ModelUsage }> {
	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
		body: JSON.stringify({
			model: 'claude-sonnet-5',
			max_tokens: 4096,
			system,
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }, citations: { enabled: true } },
						{ type: 'text', text: prompt },
					],
				},
			],
			tools: [tool],
			tool_choice: { type: 'tool', name: tool.name },
		}),
	});
	if (!res.ok) {
		throw new ExtractionError(`Anthropic API error (${res.status}): ${await res.text()}`, { inputTokens: 0, outputTokens: 0 });
	}
	const data = (await res.json()) as any;
	const usage: ModelUsage = {
		inputTokens: typeof data.usage?.input_tokens === 'number' ? data.usage.input_tokens : 0,
		outputTokens: typeof data.usage?.output_tokens === 'number' ? data.usage.output_tokens : 0,
	};
	const toolUse = data.content?.find((b: any) => b.type === 'tool_use' && b.name === tool.name);
	if (!toolUse) throw new ExtractionError(`Model did not return a ${tool.name} tool call`, usage);
	return { input: toolUse.input, usage };
}

const withSource = (item: any, sourceType: string, sourceId: string) => ({ ...item, citation: { ...item?.citation, source_type: sourceType, source_id: sourceId } });

export async function extractLabPdf(env: Env, pdfBase64: string, sourceId: string): Promise<{ extraction: LabPdfExtraction; usage: ModelUsage }> {
	const { input, usage } = await callForcedTool(
		env,
		pdfBase64,
		'You are extracting structured lab results from a scanned lab report PDF for a clinical record system. ' + SHARED_RULES,
		LAB_TOOL,
		'Extract every lab result from this document.',
	);
	const parsed = labPdfExtractionSchema.safeParse({ ...input, results: (input?.results ?? []).map((r: any) => withSource(r, 'lab_pdf', sourceId)) });
	if (!parsed.success) throw new ExtractionError(`submit_lab_extraction did not match the expected shape: ${parsed.error.message}`, usage);
	return { extraction: parsed.data, usage };
}

export async function extractIntakeForm(env: Env, pdfBase64: string, sourceId: string): Promise<{ extraction: IntakeFormExtraction; usage: ModelUsage }> {
	const { input, usage } = await callForcedTool(
		env,
		pdfBase64,
		'You are extracting structured fields from a scanned patient intake form for a clinical record system. ' +
			'Capture demographics, the chief concern, current medications (with dose and frequency when written), ' +
			'allergies (with reaction when written), and family history. Report medications and allergies exactly as ' +
			'the patient wrote them; do not normalize, correct, or add anything. ' +
			SHARED_RULES,
		INTAKE_TOOL,
		'Extract the intake form fields from this document.',
	);
	const src = (x: any) => withSource(x, 'intake_form', sourceId);
	const parsed = intakeFormExtractionSchema.safeParse({
		...input,
		demographics: (input?.demographics ?? []).map(src),
		chief_concern: input?.chief_concern ? src(input.chief_concern) : null,
		current_medications: (input?.current_medications ?? []).map(src),
		allergies: (input?.allergies ?? []).map(src),
		family_history: (input?.family_history ?? []).map(src),
	});
	if (!parsed.success) throw new ExtractionError(`submit_intake_extraction did not match the expected shape: ${parsed.error.message}`, usage);
	return { extraction: parsed.data, usage };
}
