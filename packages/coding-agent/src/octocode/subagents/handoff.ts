import crypto from "node:crypto";
import fs from "node:fs";
import type { ExtensionAPI } from "../../core/extensions/index.ts";
import { loadEntriesFromFile, type ReadonlySessionManager } from "../../core/session-manager.ts";
import { atomicWriteFileSync } from "../shared/atomic.ts";
import { claimSuffix } from "../shared/claims.ts";
import { onSecond } from "../shared/clock.ts";
import { isRecord } from "../shared/util.ts";
import { CLAIM_MARKER, claims, type Report, savePendingReport } from "./handoff/pending.ts";

export {
	pendingReportsDir,
	releasePendingReports,
	type Report,
	savePendingReport,
	takePendingReports,
} from "./handoff/pending.ts";
export {
	agentScratch,
	dropEmptyScratch,
	ReadReports,
	scratchNames,
	scratchRoot,
	sweepScratch,
} from "./handoff/scratch.ts";

/**
 * Handoff between a subagent and the session that started it: the scratch folder it leaves files in, and the delivery
 * of its background report to the parent.
 */

/** Custom message type of a background subagent's report. */
export const RESULT_TYPE = "octocode-agent-result";

/** Background reports finishing within this window reach the parent together, as one wake. */
const REPORT_BATCH_MS = 1_500;

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
