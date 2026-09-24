export interface Env {
	DB: D1Database;
	AI: Ai;
	OPENEMR_BASE_URL: string;
	OPENEMR_API_SITE: string;
	OPENEMR_CLIENT_ID: string;
	OPENEMR_CLIENT_SECRET: string;
	ANTHROPIC_API_KEY: string;
	// Optional: dashboard tracing (langfuse.ts). Absent in local dev / before setup —
	// sendLangfuseSpan no-ops rather than erroring when these aren't set.
	LANGFUSE_PUBLIC_KEY?: string;
	LANGFUSE_SECRET_KEY?: string;
	LANGFUSE_HOST?: string;
}

export interface PatientChart {
	patientId: string;
	patientName: string;
	birthDate: string | null;
	conditions: { text: string; status: string; recordedDate: string | null }[];
	medications: { text: string; status: string; authoredOn: string | null }[];
	recentObservations: { text: string; value: string; effectiveDate: string | null }[];
	// Week 2: facts extracted from uploaded documents (D1 document_facts), kept separate from
	// OpenEMR-sourced fields so the answer can distinguish "in the chart" from "from an uploaded
	// document". Optional so Week 1 code paths and tests are unaffected.
	documentFacts?: {
		text: string;
		source: string;
		// The stored citation-contract record for this fact (see schemas.ts citationSchema).
		citation?: { source_type: string; source_id: string; page_or_section: string; field_or_chunk_id: string; quote_or_value: string };
	}[];
	// Week 2: guideline excerpts retrieved for this question. Kept apart from patient-record
	// facts so the answer can distinguish "what the chart says" from "what a guideline says".
	guidelineEvidence?: { text: string; source: string; section: string; chunkId: string }[];
}

export interface Citation {
	claim: string;
	source_field: string;
}

export interface AgentAnswer {
	summary: string;
	citations: Citation[];
	uncertain_about: string[];
}
