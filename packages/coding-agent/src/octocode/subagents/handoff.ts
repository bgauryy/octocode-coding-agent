import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { uuidv7 } from "@octocodeai/octocode-ai";
import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { loadEntriesFromFile, type ReadonlySessionManager } from "../../core/session-manager.ts";
import { atomicWriteFile, atomicWriteFileSync } from "../shared/atomic.ts";
import { claimSuffix, releaseDeadClaims } from "../shared/claims.ts";
import { onSecond } from "../shared/clock.ts";
import { recordedLocalReads } from "../shared/local-reads.ts";
import {
	canonicalPath,
	privateDir,
	readPaths,
	sessionDir,
	workspacePaths,
	workspaceScratchDir,
} from "../shared/home.ts";
import { processStartTime, sameProcess } from "../shared/process.ts";
import { sweepStaleOutputs } from "../shared/sweep.ts";
import { DAY_MS, isRecord } from "../shared/util.ts";
import { teamWorkspace } from "../team/store.ts";
import type { ResultDetails } from "./render.ts";

/**
 * Handoff between a subagent and the session that started it: the scratch folder it leaves files in, and the delivery
 * of its background report to the parent.
 */

/** Custom message type of a background subagent's report. */
export const RESULT_TYPE = "octocode-agent-result";

/** Subagent scratch folders untouched this long are removed when a session starts. */
const SCRATCH_MAX_AGE_MS = 7 * DAY_MS;

/** `<workspace>/.octocode/tmp/agents`: one folder per subagent for the files it hands back. */
export const scratchRoot = (cwd: string) => path.join(workspacePaths(cwd).tmp, "agents");

/**
 * Names whose scratch folder exists. A name is a subagent's identity: its scratch folder holds its saved conversation
 * (`session/`), which Octocode reopens for the same session id. A new subagent must not take one of these names, or it would
 * continue another agent's conversation; the folder is kept (it is that agent's evidence) until the sweep removes it.
 */
export function scratchNames(cwd: string): string[] {
	try {
		return fs.readdirSync(scratchRoot(cwd));
	} catch {
		return [];
	}
}

/** File in a scratch folder naming the Octocode process that started the subagent: its pid, then its start time (so a reused pid is not mistaken for it). */
const OWNER_FILE = ".owner";

/**
 * The subagent's handoff folder, or undefined when the workspace is not writable (it then reports inline only). It
 * names this process as its owner, so another session's sweep leaves it alone while this process runs.
 */
export function agentScratch(cwd: string, id: string): string | undefined {
	try {
		const dir = workspaceScratchDir(teamWorkspace(cwd), path.join("agents", id));
		fs.writeFileSync(
			path.join(dir, OWNER_FILE),
			[process.pid, processStartTime(process.pid)].filter(Boolean).join(" "),
		);
		return dir;
	} catch {
		return undefined;
	}
}

/** Whether the process that owns a scratch folder still runs. An owner file with only a pid (start time unknown) is judged by the pid. */
function ownerRunning(dir: string): boolean {
	try {
		const [pid, ...started] = fs.readFileSync(path.join(dir, OWNER_FILE), "utf8").trim().split(" ");
		return sameProcess(Number(pid), started.join(" "));
	} catch {
		return false;
	}
}

/** Removes scratch folders untouched for a week, except those whose owning Octocode process (this or another session) is alive. */
export async function sweepScratch(root: string): Promise<void> {
	let names: string[];
	try {
		names = await fs.promises.readdir(root);
	} catch {
		return;
	}
	const owned = new Set(names.filter((name) => ownerRunning(path.join(root, name))));
	await sweepStaleOutputs(root, SCRATCH_MAX_AGE_MS, owned);
}

/** Background reports finishing within this window reach the parent together, as one wake. */
const REPORT_BATCH_MS = 1_500;

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
const CLAIM_MARKER = ".claim-";

/** The pending files behind the reports `takePendingReports` returned: where each is claimed, and the name it goes back to. */
const claims = new WeakMap<Report, { claim: string; file: string }>();

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
			const value: unknown = JSON.parse(await fsp.readFile(claim, "utf8"));
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
				throw new Error("Invalid pending subagent report");
			const report = value as unknown as Report;
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
			// Unreadable: it stays where it was.
			try {
				await fsp.rename(claim, file);
			} catch {
				// Gone meanwhile.
			}
		}
	}
	return taken;
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

/**
 * Delivers background reports. Reports that finish close together are batched: all are sent at once and only the last
 * may start a turn, so three subagents finishing in a second cost one parent turn instead of three. Delivery is
 * at-least-once: recovery copies are deleted only after the parent session records their report IDs. A send call can
 * fail asynchronously: rejected sends get three bounded retries in the live session. Accepted but unrecorded
 * sends are never retried speculatively; recovery copies remain until a receipt or shutdown persistence.
 */
export class ReportQueue {
	private queued: Report[] = [];
	private timer: NodeJS.Timeout | undefined;
	private readonly pending = new Map<string, Report>();
	private readonly retries = new Map<string, { attempts: number; timer?: NodeJS.Timeout }>();
	private session: Pick<ReadonlySessionManager, "getEntries" | "getSessionFile"> | undefined;
	private recordedStamp: string | undefined;
	private stopClock: (() => void) | undefined;
	/** Ids recorded in the parent session. */
	private readonly known = new Set<string>();
	/** The pending folder of the Octocode session this queue serves: where a report that could not be sent is saved. */
	pendingDir: string | undefined;

	private readonly pi: ExtensionAPI;
	private readonly windowMs: number;
	constructor(pi: ExtensionAPI, windowMs = REPORT_BATCH_MS) {
		this.pi = pi;
		this.windowMs = windowMs;
	}

	start(session: Pick<ReadonlySessionManager, "getEntries" | "getSessionFile">): void {
		this.persist();
		this.session = session;
		this.known.clear();
		this.recordedStamp = undefined;
		this.recorded();
	}

	/** Session entries, rather than send-call returns, acknowledge accepted reports. */
	recorded(): void {
		if (!this.session) return;
		const file = this.session.getSessionFile();
		let entries: ReturnType<typeof loadEntriesFromFile> = [];
		if (file) {
			try {
				const stat = fs.statSync(file);
				const stamp = `${file}:${stat.mtimeMs}:${stat.size}`;
				if (stamp !== this.recordedStamp) {
					entries = loadEntriesFromFile(file);
					this.recordedStamp = stamp;
				}
			} catch {
				// A not-yet-created or unreadable transcript is not a receipt.
			}
		} else entries = this.session.getEntries();
		for (const entry of entries) {
			if (entry.type !== "custom_message" || entry.customType !== RESULT_TYPE || !isRecord(entry.details)) continue;
			const id = entry.details.reportId;
			if (typeof id !== "string") continue;
			this.known.add(id);
		}
		for (const [id, report] of this.pending) {
			if (this.known.has(id)) {
				try {
					this.settle(report);
				} catch {
					// Retry cleanup on the next tick; the session receipt prevents another delivery.
				}
			}
		}
		if (this.pending.size === 0) {
			this.stopClock?.();
			this.stopClock = undefined;
		}
	}

	add(report: Report): void {
		report.reportId ??= crypto.randomUUID();
		if (this.known.has(report.reportId)) {
			this.settle(report);
			return;
		}
		const existing = this.pending.get(report.reportId);
		if (existing) {
			const claim = claims.get(report);
			if (claim && !claims.has(existing)) {
				claims.set(existing, claim);
				claims.delete(report);
			} else if (report !== existing) this.removeClaim(report);
			return;
		}
		this.pending.set(report.reportId, report);
		if (!claims.has(report) && this.pendingDir) {
			const file = savePendingReport(this.pendingDir, report.details.id, report);
			if (file) {
				const claim = `${file}${claimSuffix(CLAIM_MARKER)}`;
				try {
					fs.renameSync(file, claim);
					claims.set(report, { claim, file });
				} catch {
					// The saved copy remains available to the next pending-report scan.
				}
			}
		}
		this.queued.push(report);
		this.stopClock ??= onSecond(() => this.recorded());
		if (this.timer) return;
		this.timer = setTimeout(() => this.flush(), this.windowMs);
		this.timer.unref?.();
	}

	flush(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		const batch = this.queued.filter((report) => report.reportId && this.pending.has(report.reportId));
		this.queued = [];
		const wake = batch.some((report) => report.wake);
		const last = batch.at(-1);
		if (wake && last && !last.wake) {
			// The final send carries the whole batch's wake, including on retry or recovery.
			last.wake = true;
			const claim = claims.get(last);
			if (claim) {
				try {
					const saved = JSON.parse(fs.readFileSync(claim.claim, "utf8")) as Report;
					atomicWriteFileSync(claim.claim, JSON.stringify({ ...saved, wake: true }), { mode: 0o600 });
				} catch {
					// Keep live delivery working if recovery storage became unavailable.
				}
			}
		}
		batch.forEach((report, index) => {
			// A send may synchronously end or replace the session; the remaining batch then belongs to recovery.
			if (!report.reportId || this.pending.get(report.reportId) !== report) return;
			try {
				// followUp: read once the current turn ends; triggerTurn wakes an idle parent, once per batch.
				const sending = this.pi.sendMessage(
					{
						customType: RESULT_TYPE,
						content: report.content,
						display: true,
						details: { ...report.details, reportId: report.reportId },
					},
					{ triggerTurn: wake && index === batch.length - 1, deliverAs: "followUp" },
				);
				if (sending && typeof sending.then === "function")
					void Promise.resolve(sending).catch(() => this.retry(report));
			} catch {
				// The session ended before the subagent finished: the report waits for the next start.
				this.retain(report);
				return;
			}
		});
		this.recorded();
	}

	private retry(report: Report): void {
		const id = report.reportId;
		if (!id || this.pending.get(id) !== report) return;
		this.recorded();
		if (
			!this.pending.has(id) ||
			this.session
				?.getEntries()
				.some(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === RESULT_TYPE &&
						isRecord(entry.details) &&
						entry.details.reportId === id,
				)
		)
			return;
		const retry = this.retries.get(id) ?? { attempts: 0 };
		if (retry.timer || retry.attempts >= 3) return;
		retry.attempts++;
		retry.timer = setTimeout(
			() => {
				retry.timer = undefined;
				if (this.pending.get(id) !== report) return;
				this.queued.push(report);
				this.flush();
			},
			1000 * 2 ** (retry.attempts - 1),
		);
		retry.timer.unref?.();
		this.retries.set(id, retry);
	}

	private clearRetry(id: string | undefined): void {
		if (!id) return;
		clearTimeout(this.retries.get(id)?.timer);
		this.retries.delete(id);
	}

	/** Saves what is still queued for the next start of the session (a shutdown that does not send it). */
	persist(): void {
		this.recorded();
		clearTimeout(this.timer);
		this.timer = undefined;
		this.stopClock?.();
		this.stopClock = undefined;
		const batch = [...this.pending.values()];
		this.queued = [];
		for (const report of batch) this.retain(report);
	}

	/** The report reached Octocode (or is a copy of one that did): its pending file is no longer needed. */
	private settle(report: Report): void {
		this.removeClaim(report);
		this.clearRetry(report.reportId);
		if (report.reportId) this.pending.delete(report.reportId);
	}

	private removeClaim(report: Report): void {
		const claim = claims.get(report);
		if (claim) fs.rmSync(claim.claim, { force: true });
		claims.delete(report);
	}

	/** The report did not reach Octocode: it goes back to the pending folder, and may be queued again when taken. */
	private retain(report: Report): void {
		this.clearRetry(report.reportId);
		if (report.reportId !== undefined) this.pending.delete(report.reportId);
		const claim = claims.get(report);
		claims.delete(report);
		if (claim) {
			try {
				fs.renameSync(claim.claim, claim.file);
			} catch {
				// The claim is gone; nothing to give back.
			}
		} else if (this.pendingDir) savePendingReport(this.pendingDir, report.details.id, report);
	}
}

/**
 * Report files the parent has read through local fetch or a legacy reader, by agent id, with the time.
 * A report whose file was read after its last change reaches the parent without starting a turn.
 */
export class ReadReports {
	private readonly scratch = new Map<string, string>();
	private readonly readAt = new Map<string, number>();

	track(id: string, scratch: string | undefined): void {
		if (scratch) this.scratch.set(canonicalPath(path.join(path.resolve(scratch), "report.md")), id);
	}

	observe(toolName: string, input: Record<string, unknown>, cwd: string, details?: unknown): void {
		for (const file of [...readPaths(toolName, input, cwd), ...recordedLocalReads(details).map((read) => read.file)]) {
			const id = this.scratch.get(canonicalPath(file));
			if (id) this.readAt.set(id, Date.now());
		}
	}

	/** Whether the parent read this agent's report file since it was last written; forgets the agent. */
	consume(id: string): boolean {
		const at = this.readAt.get(id);
		const file = [...this.scratch].find(([, owner]) => owner === id)?.[0];
		this.readAt.delete(id);
		if (file) this.scratch.delete(file);
		if (at === undefined || !file) return false;
		try {
			return fs.statSync(file).mtimeMs <= at;
		} catch {
			return false;
		}
	}
}

/** Removes a scratch folder the subagent left empty (only the owner marker), so finished runs leave no clutter. */
export function dropEmptyScratch(dir: string | undefined): boolean {
	if (!dir) return false;
	try {
		if (fs.readdirSync(dir).some((name) => name !== OWNER_FILE)) return false;
		fs.rmSync(dir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}
