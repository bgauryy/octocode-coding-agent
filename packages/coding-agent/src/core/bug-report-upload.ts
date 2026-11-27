import type { BugReportBundle } from "./bug-report.ts";
import { bugReportFiles } from "./bug-report.ts";

interface UploadBugReportOptions {
	token?: string;
	signal?: AbortSignal;
	gatewayUrl?: string;
}

export const BUG_REPORT_URL_ENV = "OCTOCODE_BUG_REPORT_URL";

/**
 * The configured report service: `{ url }`, `{ error }` when the value is not an http(s) URL (so callers can say so
 * and still offer a local export), or undefined when uploads are not configured.
 */
export function bugReportUploadTarget(
	value: string | undefined = process.env[BUG_REPORT_URL_ENV],
): { url: URL } | { error: string } | undefined {
	const text = value?.trim();
	if (!text) return undefined;
	const url = URL.canParse(text) ? new URL(text) : undefined;
	if (url && (url.protocol === "https:" || url.protocol === "http:")) return { url };
	return { error: `${BUG_REPORT_URL_ENV} is not a valid http(s) URL, so uploads are unavailable.` };
}

/** Upload a report as multipart form data to `OCTOCODE_BUG_REPORT_URL`, optionally with a bearer token. */
export async function uploadBugReport(
	bundle: BugReportBundle,
	options: UploadBugReportOptions = {},
): Promise<{ id: string }> {
	const target = bugReportUploadTarget(options.gatewayUrl ?? process.env[BUG_REPORT_URL_ENV]);
	if (!target) throw new Error("Bug report uploads are not configured. Export as Zip instead.");
	if ("error" in target) throw new Error(`${target.error} Export as Zip instead.`);
	const gatewayUrl = target.url;
	const body = new FormData();
	for (const file of bugReportFiles(bundle)) {
		body.append(file.name, new Blob([file.data], { type: file.contentType }), file.name);
	}
	const response = await fetch(new URL("/v1/bug-reports", gatewayUrl), {
		method: "POST",
		headers: options.token ? { Authorization: `Bearer ${options.token}` } : undefined,
		body,
		signal: options.signal,
	});
	const json = (await response.json().catch(() => null)) as {
		ok?: boolean;
		bug_report?: { id?: string };
		error?: string;
		description?: string;
	} | null;
	if (response.ok && json?.ok === true && typeof json.bug_report?.id === "string") {
		return { id: json.bug_report.id };
	}
	const detail = json && !json.ok ? json.description || json.error : undefined;
	throw new Error(`Bug report upload failed: ${detail || response.statusText || response.status}`);
}
