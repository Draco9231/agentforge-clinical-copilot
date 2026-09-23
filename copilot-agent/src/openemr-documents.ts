import type { Env } from './types';

function standardApiBase(env: Env): string {
	return `${env.OPENEMR_BASE_URL}/apis/${env.OPENEMR_API_SITE}/api`;
}

// The standard (non-FHIR) /api/patient/:pid/document endpoint takes OpenEMR's internal numeric
// pid, not the FHIR patient UUID this app uses everywhere else — confirmed live (2026-09-23) via
// a 400 "Invalid pid" when passing the UUID directly. There is no documented way to resolve one
// from the other except listing patients and matching by uuid; with a handful of demo patients
// this is cheap, but it would need a targeted server-side filter at real scale.
export async function resolveNumericPid(env: Env, token: string, patientUuid: string): Promise<number | null> {
	const res = await fetch(`${standardApiBase(env)}/patient`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!res.ok) return null;
	const body = (await res.json()) as { data?: { pid: number; uuid: string }[] };
	const match = (body.data ?? []).find((p) => p.uuid === patientUuid);
	return match ? match.pid : null;
}

export interface DocumentUploadResult {
	uploaded: boolean;
	error?: string;
}

// KNOWN BUG in this OpenEMR fork's DocumentService (traced live 2026-09-23, src/Services/DocumentService.php):
// - isValidPath() does `explode('/', $path)` then `unset($docPathParts[0])`. A single-segment
//   category name (no leading slash) becomes an empty array after the unset, so its validation
//   loop never runs and the function always returns true — it cannot actually reject a bad
//   category name.
// - getLastIdOfPath() compares the raw input directly against `replace(LOWER(name), ' ', '')`
//   without ever lowering or stripping spaces from the input side, so a category name with any
//   uppercase letter or space (e.g. "Lab Reports") can never match and always resolves to a null
//   category id — silently. The upload call still returns `true` in this case (createDocument
//   doesn't validate the category id it's given), and the file becomes unreachable through the
//   category-scoped list endpoint (which reads back as an empty result, itself misreported as a
//   plain 404 by RestControllerHelper's `if ($serviceResult)` truthiness check on an empty array).
// - Direct per-id fetch (GET .../document/:did) returned 500, not 404, for several ids after
//   this — plausibly encryption-related, not confirmed further; the point is that neither read
//   path can be trusted to confirm what got stored.
//
// Net effect: this endpoint cannot be used as a readable system of record. It's still called
// here, best-effort, because the requirement is "store the source document in OpenEMR" and the
// write does appear to succeed — a physician can find it through OpenEMR's own UI. But this
// Worker's own D1 `documents` table (see documents.ts), not OpenEMR, is the source of truth for
// citation linking, because OpenEMR cannot confirm back what it received.
export async function uploadDocumentToOpenEmr(
	env: Env,
	token: string,
	numericPid: number,
	fileBytes: ArrayBuffer,
	fileName: string,
	category: string,
): Promise<DocumentUploadResult> {
	const form = new FormData();
	form.append('document', new Blob([fileBytes], { type: 'application/pdf' }), fileName);

	const res = await fetch(`${standardApiBase(env)}/patient/${numericPid}/document?path=${encodeURIComponent(category)}`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` },
		body: form,
	});
	if (!res.ok) {
		const body = await res.text();
		return { uploaded: false, error: `OpenEMR document upload failed (${res.status}): ${body}` };
	}
	return { uploaded: true };
}
