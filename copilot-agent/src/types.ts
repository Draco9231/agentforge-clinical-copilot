export interface Env {
	DB: D1Database;
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
