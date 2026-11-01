import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { uuidv7 } from "@octocodeai/octocode-ai";
import { atomicWriteFile, atomicWriteFileSync } from "../../../../../common/src/atomic-file.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { ResultDetails } from "../run-types.ts";
import { claimSuffix, releaseDeadClaims } from "../../shared/claims.ts";
import { privateDir, sessionDir } from "../../shared/home.ts";
import { validateStoredStructuredResult } from "../result-schema.ts";

export interface Report {
	content: string;
	details: ResultDetails;
	/** Start a parent turn for it (not for a stop someone asked for, nor a report the parent already read). */
	wake: boolean;
	/** Names this one report wherever it is saved, claimed or queued, so a copy is never delivered twice; stamped when it is first queued or saved. */
	reportId?: string;
}

/**
 * `<session folder>/reports/pending`: background reports that finished after the session that started them ended (a
 * reload, /resume of another session), kept owner-only for the next start of the same Octocode session.
 */
export const pendingReportsDir = (sessionId: string, env: NodeJS.ProcessEnv = process.env): string =>
	path.join(sessionDir(sessionId, env), "reports", "pending");

/**
 * A pending report being delivered is renamed `<report>.json.claim-<pid>-<start time>` by the process that took it
 * (`shared/claims.ts`): it is deleted once Octocode accepted the message and renamed back when it did not, and a claim whose
 * process died is given back by the next take, so a crash between claim and send loses nothing.
 */
export const CLAIM_MARKER = ".claim-";

/** The pending files behind the reports `takePendingReports` returned: where each is claimed, and the name it goes back to. */
export const claims = new WeakMap<Report, { claim: string; file: string }>();

/** Saves a report nobody could receive; never throws (a report that cannot be saved is lost). */
export function savePendingReport(dir: string, id: string, report: Report): string | undefined {
	try {
		privateDir(dir);
		const saved: Report = { ...report, reportId: report.reportId ?? crypto.randomUUID() };
		const file = path.join(dir, `${Date.now()}-${uuidv7()}-${id.replace(/[^\w.-]/g, "_")}.json`);
		atomicWriteFileSync(file, JSON.stringify(saved), {
			mode: 0o600,
		});
		return file;
	} catch {
		// No disk: nothing more to do.
	}
}

/**
 * The saved reports, oldest first, each claimed by a rename so two processes never take one. The claim stays until
 * `ReportQueue` delivers the report (deleted) or fails to (renamed back); a report saved twice is delivered once.
 * Async: the poll for late reports runs every second, and the disk must not block the event loop.
 */
export async function takePendingReports(dir: string): Promise<Report[]> {
	let names: string[];
	try {
		await releaseDeadClaims(dir, await fsp.readdir(dir), CLAIM_MARKER, (original) => original.endsWith(".json"));
		names = (await fsp.readdir(dir)).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return [];
	}
	const seen = new Set<string>();
	const taken: Report[] = [];
	for (const name of names) {
		const file = path.join(dir, name);
		const claim = `${file}${claimSuffix(CLAIM_MARKER)}`;
		try {
			await fsp.rename(file, claim);
		} catch {
			continue;
		}
		try {
			const report = parseReport(await fsp.readFile(claim, "utf8"));
			if (typeof report === "string") {
				// Moved aside, not renamed back: it would be read again at every take and never delivered. It keeps its bytes
				// for diagnosis, and `.invalid` does not end in `.json`, so no take reads it again. Saves appear only by an
				// atomic rename (`savePendingReport`), so a report still being written is never judged here.
				await fsp.rename(claim, `${file}.invalid`);
				process.stderr.write(`Quarantined a saved subagent report ${report}: ${file}.invalid\n`);
				continue;
			}
			if (report.reportId === undefined) {
				report.reportId = crypto.randomUUID();
				await atomicWriteFile(claim, JSON.stringify(report), undefined, { mode: 0o600 });
			}
			if (report.reportId !== undefined && seen.has(report.reportId)) {
				await fsp.rm(claim, { force: true });
				continue;
			}
			if (report.reportId !== undefined) seen.add(report.reportId);
			const late = { ...report, content: `(Arrived after the session restarted) ${report.content}` };
			claims.set(late, { claim, file });
			taken.push(late);
		} catch {
			// Unreadable now (an I/O error, not bad content): it goes back for the next take.
			try {
				await fsp.rename(claim, file);
			} catch {
				// Gone meanwhile.
			}
		}
	}
	return taken;
}

/**
 * A saved report as `takePendingReports` delivers it, or why it cannot be one: text that is not JSON, a shape no
 * Octocode saves, or result schema metadata that fails validation (a false typed result must not be delivered).
 */
function parseReport(text: string): Report | string {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return "that is not JSON";
	}
	if (
		!isRecord(value) ||
		typeof value.content !== "string" ||
		typeof value.wake !== "boolean" ||
		!isRecord(value.details) ||
		typeof value.details.id !== "string" ||
		typeof value.details.summary !== "string" ||
		!["done", "failed", "stopped"].includes(String(value.details.status)) ||
		(value.reportId !== undefined && (typeof value.reportId !== "string" || !value.reportId))
	)
		return "that is not a valid report";
	if (value.details.structured !== undefined) {
		try {
			validateStoredStructuredResult(value.details.structured);
		} catch {
			return "with invalid result schema metadata";
		}
	}
	return value as unknown as Report;
}

/** Return a scan's claims to their original session when that session ends during the read. */
export async function releasePendingReports(reports: readonly Report[]): Promise<void> {
	for (const report of reports) {
		const claim = claims.get(report);
		if (!claim) continue;
		await fsp.rename(claim.claim, claim.file);
		claims.delete(report);
	}
}
