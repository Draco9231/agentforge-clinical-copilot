import type { Env } from './types';
import { labPdfExtractionSchema } from './schemas';
import { sumUsage, type ModelUsage } from './cost';

export interface LabPdfExtraction {
	results: {
		test_name: string;
		value: string;
		unit?: string | null;
		reference_range?: string | null;
		collection_date?: string | null;
		abnormal_flag: 'normal' | 'high' | 'low' | 'critical' | 'unknown';
		citation: {
			source_type: 'lab_pdf' | 'intake_form';
			source_id: string;
			page_or_section: string;
			field_or_chunk_id: string;
			quote_or_value: string;
		};
	}[];
	extraction_confidence: 'high' | 'medium' | 'low';
	unparsed_notes: string[];
}

export interface ExtractionResult {
	extraction: LabPdfExtraction;
	usage: ModelUsage;
}

const SUBMIT_LAB_EXTRACTION_TOOL = {
	name: 'submit_lab_extraction',
	description:
		'Submit the structured lab results extracted from this PDF. Every result MUST include a ' +
		'citation with the exact page number you read it from and the exact quoted text or value. ' +
		'Never invent a test result, value, or date that is not actually legible in the document. ' +
		'If a field for a given test is genuinely not present or not legible, leave it null rather ' +
		'than guessing — do not fabricate a plausible-looking value.',
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
						citation: {
							type: 'object',
							properties: {
								page_or_section: { type: 'string', description: 'Page number this was read from, e.g. "1"' },
								field_or_chunk_id: { type: 'string', description: 'A short identifier for this field, e.g. "hemoglobin"' },
								quote_or_value: { type: 'string', description: 'The exact text as it appears in the document' },
							},
							required: ['page_or_section', 'field_or_chunk_id', 'quote_or_value'],
						},
					},
					required: ['test_name', 'value', 'abnormal_flag', 'citation'],
				},
			},
			extraction_confidence: {
				type: 'string',
				enum: ['high', 'medium', 'low'],
				description: 'Your honest confidence in this extraction given scan quality, legibility, and ambiguity.',
			},
			unparsed_notes: {
				type: 'array',
				items: { type: 'string' },
				description: 'Anything on the page you could not confidently extract as a structured result.',
			},
		},
		required: ['results', 'extraction_confidence', 'unparsed_notes'],
	},
};

export class ExtractionError extends Error {
	usage: ModelUsage;
	constructor(message: string, usage: ModelUsage) {
		super(message);
		this.usage = usage;
	}
}

// Claude Sonnet 5 reads the PDF natively (base64 document content block) rather than going
// through a separate OCR/VLM pipeline — it supports PDF input directly, and turning on
// `citations` ties every extracted fact back to a real page in the source document as part of
// the model's own response, not something bolted on after the fact. sourceId is our own D1
// document id (assigned before this call — see index.ts's attach_and_extract handler), not an
// OpenEMR id, per the finding in openemr-documents.ts.
export async function extractLabPdf(env: Env, pdfBase64: string, sourceId: string): Promise<ExtractionResult> {
	const system =
		'You are extracting structured lab results from a scanned lab report PDF for a clinical ' +
		'record system. Read only what is actually legible in the document. Every result you ' +
		'report must be traceable to a specific page and quoted text — never state a value you ' +
		"cannot point to in the document. Always respond by calling submit_lab_extraction.";

	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': env.ANTHROPIC_API_KEY,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({
			model: 'claude-sonnet-5',
			max_tokens: 4096,
			system,
			messages: [
				{
					role: 'user',
					content: [
						{
							type: 'document',
							source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
							citations: { enabled: true },
						},
						{ type: 'text', text: 'Extract every lab result from this document.' },
					],
				},
			],
			tools: [SUBMIT_LAB_EXTRACTION_TOOL],
			tool_choice: { type: 'tool', name: 'submit_lab_extraction' },
		}),
	});

	if (!res.ok) {
		const body = await res.text();
		throw new ExtractionError(`Anthropic API error (${res.status}): ${body}`, { inputTokens: 0, outputTokens: 0 });
	}

	const data = (await res.json()) as any;
	const usage: ModelUsage = {
		inputTokens: typeof data.usage?.input_tokens === 'number' ? data.usage.input_tokens : 0,
		outputTokens: typeof data.usage?.output_tokens === 'number' ? data.usage.output_tokens : 0,
	};

	const toolUse = data.content?.find((block: any) => block.type === 'tool_use' && block.name === 'submit_lab_extraction');
	if (!toolUse) {
		throw new ExtractionError('Model did not return a submit_lab_extraction tool call', usage);
	}

	// The model's own tool input never carries source_type/source_id — those are ours to attach,
	// not the model's to invent, since it has no way to know our internal document id.
	const withSource = {
		...toolUse.input,
		results: (toolUse.input?.results ?? []).map((r: any) => ({
			...r,
			citation: { ...r.citation, source_type: 'lab_pdf', source_id: sourceId },
		})),
	};

	const parsed = labPdfExtractionSchema.safeParse(withSource);
	if (!parsed.success) {
		throw new ExtractionError(`Model's submit_lab_extraction call did not match the expected shape: ${parsed.error.message}`, usage);
	}
	return { extraction: parsed.data as LabPdfExtraction, usage };
}

export function sumExtractionUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
	return sumUsage(a, b);
}
