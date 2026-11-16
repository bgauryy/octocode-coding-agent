import { renderInstruction } from "../../core/prompt-template.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import type { ExtensionAPI } from "../../core/features/index.ts";
import { claimSuffix } from "../shared/claims.ts";
import { onSecond } from "../shared/clock.ts";
import { rewriteClaim } from "./handoff/claim-file.ts";
import { CLAIM_MARKER, claims, type Report, savePendingReport } from "./handoff/pending.ts";
import { type ReceiptSession, ReportReceipts } from "./handoff/receipts.ts";
import { shortPath } from "../../utils/display-path.ts";
import { sendAgentReport } from "./handoff/wake.ts";

/**
 * Handoff between a subagent and the session that started it: the scratch folder it leaves files in, and the delivery
 * of its background report to the parent.
 */

type Hold = (queued: readonly string[]) => ReadonlySet<string>;

/** Custom message type of the short mid-turn notice that a background report is on its way (never the report). */
export const NOTICE_TYPE = "octocode-agent-notice";

/** Rejected sends are retried 3 times quickly (1 s, 2 s, 4 s), then 3 times slowly, so a long outage heals without a restart. */
const FAST_RETRIES = 3;
const SLOW_RETRIES = 3;
const SLOW_RETRY_MS = 30_000;

/**
 * Delivers background reports. A report goes out at the end of the tick it arrives in, unless it waits for a sibling of
 * its own parent step whose report is being built (`hold`, `report-groups.ts`). Then it goes out with that sibling's
 * report, and only the last send of a batch may start a turn: children of one step that finish together cost one parent
 * turn. Reports that do not wait go without the held ones. No timer holds a report: every wait ends with the sibling's
 * run, a stall or the end of its supervised run (`reportingChanged`).
 * A parent in a turn reads every report that arrived meanwhile as follow-ups, together. Delivery is at-least-once:
 * recovery copies are deleted only after the parent session records their report IDs. A send call can fail
 * asynchronously: rejected sends get three quick retries and three slow ones (30 s, 1 min, 2 min) in the live session.
 * Accepted but unrecorded sends are never retried speculatively; recovery copies remain until a receipt or shutdown
 * persistence.
 */
export class ReportQueue {
	private queued: Report[] = [];
	private timer: NodeJS.Timeout | undefined;
	private readonly pending = new Map<string, Report>();
	private readonly retries = new Map<string, { attempts: number; timer?: NodeJS.Timeout; told?: boolean }>();
	/** Says something to the person watching, when one is. */
	private warn: (text: string) => void = () => undefined;
	private session: ReceiptSession | undefined;
	private receipts = new ReportReceipts();
	/** Whether the parent is between turns; reports finishing while it is not also get a short steering notice. */
	private idle: () => boolean = () => true;
	/** Rewrites a sent report that still waits unread in the session's queue. */
	private replaceQueued: (details: object, content: string) => boolean = () => false;
	/** The `details` object of each report's latest send: what identifies it in the session's queue. */
	private readonly sent = new WeakMap<Report, object>();
	/** Reports whose notice was sent. */
	private readonly noticed = new Set<string>();
	/** Notices waiting for the parent's next step (`stepEnded`). */
	private noticesWaiting = new Set<string>();
	private stopClock: (() => void) | undefined;
	/** The pending folder of the Octocode session this queue serves: where a report that could not be sent is saved. */
	pendingDir: string | undefined;

	private readonly api: ExtensionAPI;
	private readonly hold: Hold | undefined;
	/** The backlog item of each child by id: what a report wakes the parent about. */
	private readonly items: ReadonlyMap<string, string> | undefined;
	/**
	 * `hold`: the children (of the queued reports' child ids) whose reports wait for a sibling's report
	 * (`report-groups.ts`). Without it, or when it throws, every report goes out at the end of its tick.
	 */
	constructor(api: ExtensionAPI, hold?: Hold, items?: ReadonlyMap<string, string>) {
		this.api = api;
		this.hold = hold;
		this.items = items;
	}

	/** The queued reports that go now: those whose sibling's report is not about to join them (`hold`). Unknown state holds none. */
	private ready(): Report[] {
		if (!this.hold || this.queued.length === 0) return this.queued;
		try {
			const held = this.hold(this.queued.map((report) => report.details.id));
			return held.size === 0 ? this.queued : this.queued.filter((report) => !held.has(report.details.id));
		} catch {
			return this.queued;
		}
	}

	/** Whether the parent is between turns; a replaced session counts as idle (its reports go through recovery). */
	private parentIdle(): boolean {
		try {
			return this.idle();
		} catch {
			return true;
		}
	}

	/** Sends what does not wait at the end of this tick (`ready`); checked again when the timer fires. */
	private schedule(): void {
		if (this.timer || this.ready().length === 0) return;
		// The rest of this tick still joins the batch: reports added in one loop (recovered ones) remain one wake.
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flushReady();
		}, 0);
		this.timer.unref?.();
	}

	/** Sends the queued reports that do not wait (`ready`, which fails open); the held ones stay queued for their sibling. */
	private flushReady(): void {
		const ready = this.ready();
		if (ready.length > 0) this.flush(ready);
	}

	/** What the batch waits for may have changed (a sibling's run ended, or its report build stalled): check again. */
	reportingChanged(): void {
		this.schedule();
	}

	start(
		session: ReceiptSession,
		isIdle?: () => boolean,
		warn?: (text: string) => void,
		replaceQueued?: (details: object, content: string) => boolean,
	): void {
		this.persist();
		this.session = session;
		this.idle = isIdle ?? (() => true);
		this.warn = warn ?? (() => undefined);
		this.replaceQueued = replaceQueued ?? (() => false);
		this.receipts = new ReportReceipts();
		this.noticed.clear();
		this.recorded();
	}

	/** Session entries, rather than send-call returns, acknowledge accepted reports. */
	recorded(): void {
		if (!this.session) return;
		this.receipts.scan(this.session);
		for (const [id, report] of this.pending) {
			if (this.receipts.has(id)) {
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
		if (this.receipts.has(report.reportId)) {
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
		this.schedule();
	}

	/** Sends `only` (every queued report by default) as one batch; the rest stays queued. */
	flush(only: readonly Report[] = this.queued): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		const batch = only.filter((report) => report.reportId && this.pending.has(report.reportId));
		this.queued = only === this.queued ? [] : this.queued.filter((report) => !only.includes(report));
		const wake = batch.some((report) => report.wake);
		const busy = !this.parentIdle();
		this.notify(batch);
		const last = batch.at(-1);
		if (wake && last && !last.wake) {
			// The final send carries the whole batch's wake, including on retry or recovery.
			last.wake = true;
			rewriteClaim(last);
		}
		batch.forEach((report, index) => {
			// A send may synchronously end or replace the session; the remaining batch then belongs to recovery.
			if (!report.reportId || this.pending.get(report.reportId) !== report) return;
			try {
				// followUp: read once the current turn ends, with every other report waiting then; triggerTurn wakes an idle parent, once per batch.
				const details = { ...report.details, reportId: report.reportId };
				this.sent.set(report, details);
				const sending = sendAgentReport(
					this.api,
					report,
					details,
					this.items?.get(report.details.id),
					// A busy parent (a turn, or a run deciding whether to go on) reads every send of a waking batch as one
					// follow-up drained together; an idle one gets the batch written and one turn from the last send.
					wake && (busy || index === batch.length - 1),
				);
				if (sending && typeof sending.then === "function")
					void Promise.resolve(sending).catch(() => this.retry(report));
			} catch {
				// The session ended before the subagent finished: the report waits for the next start.
				this.retain(report);
			}
		});
		this.recorded();
	}

	/**
	 * A parent in the middle of a turn reads a short notice (agent, outcome, report path) at its next step; the whole report
	 * still arrives as a follow-up when the turn ends. Only the parent's own facts go in it: the child's words stay in the
	 * fenced report. Silent for a stop someone asked for, a report already read, and an idle parent (the report wakes it).
	 * It waits for `stepEnded`: sent while the parent streams its last reply, it would start a request of its own only to say
	 * that the report follows.
	 */
	private notify(batch: Report[]): void {
		if (this.parentIdle()) return;
		for (const report of batch) {
			const id = report.reportId;
			if (!id || !report.wake || this.noticed.has(id)) continue;
			this.noticed.add(id);
			this.noticesWaiting.add(id);
		}
	}

	/**
	 * A run is being resumed: what its unread reports say about waiting and unanswered asks is about to be false. Each is
	 * marked wherever it waits (the batch window, its recovery copy, the session's queue). One already recorded was read.
	 */
	supersede(id: string): void {
		this.recorded();
		for (const report of this.pending.values()) {
			if (report.details.id !== id || report.superseded) continue;
			report.superseded = true;
			report.content = `${report.content}\n\n${renderInstruction("notices/subagents/superseded.md", { id })}`;
			rewriteClaim(report);
			const details = this.sent.get(report);
			try {
				if (details) this.replaceQueued(details, report.content);
			} catch {
				// The session was replaced: the report goes to the next one from its recovery copy, marked.
			}
		}
	}

	/** A step of the parent's turn ran tools, so another request follows: the notices of reports it has not read join that request. */
	stepEnded(): void {
		const waiting = this.noticesWaiting;
		this.noticesWaiting = new Set();
		for (const id of waiting) {
			const report = this.pending.get(id);
			// The report itself arrived first: its notice has nothing to add. A resume made it out of date.
			if (!report || report.superseded) continue;
			try {
				void Promise.resolve(
					this.api.sendMessage(
						{ customType: NOTICE_TYPE, content: noticeText(report), display: false, details: { reportId: id } },
						{ triggerTurn: false, deliverAs: "steer" },
					),
				).catch(() => undefined);
			} catch {
				// The notice is best effort; the report itself is delivered and recorded.
			}
		}
	}

	private retry(report: Report): void {
		const id = report.reportId;
		if (!id || this.pending.get(id) !== report) return;
		this.recorded();
		if (!this.pending.has(id)) return;
		const retry: { attempts: number; timer?: NodeJS.Timeout; told?: boolean } = this.retries.get(id) ?? { attempts: 0 };
		if (retry.timer) return;
		if (retry.attempts >= FAST_RETRIES + SLOW_RETRIES) {
			// The report stays claimed: `retryExhausted` sends it again after the next settled turn, and shutdown saves it.
			this.retries.set(id, retry);
			if (!retry.told) {
				retry.told = true;
				this.warn(`The report of ${report.details.id} could not be delivered; it is retried after the next turn.`);
			}
			return;
		}
		retry.attempts++;
		retry.timer = setTimeout(
			() => {
				retry.timer = undefined;
				if (this.pending.get(id) !== report) return;
				// A retry waits for a sibling like a first send, and never takes held reports along.
				this.queued.push(report);
				this.flushReady();
			},
			retry.attempts <= FAST_RETRIES
				? 1000 * 2 ** (retry.attempts - 1)
				: SLOW_RETRY_MS * 2 ** (retry.attempts - FAST_RETRIES - 1),
		);
		retry.timer.unref?.();
		this.retries.set(id, retry);
	}

	/** A turn just settled, so the session can take messages again: one more send of each report the timed retries gave up on. */
	retryExhausted(): void {
		let any = false;
		for (const [id, retry] of this.retries) {
			const report = this.pending.get(id);
			if (!report || retry.timer || retry.attempts < FAST_RETRIES + SLOW_RETRIES) continue;
			this.queued.push(report);
			any = true;
		}
		if (any) this.flushReady();
	}

	/** The children whose reports are held for delivery now, so nobody tells the model they went silent. */
	pendingIds(): ReadonlySet<string> {
		return new Set([...this.pending.values()].map((report) => report.details.id));
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
		this.noticesWaiting.clear();
		for (const report of batch) this.retain(report);
	}

	/** The report reached Octocode (or is a copy of one that did): its pending file is no longer needed. */
	private settle(report: Report): void {
		this.removeClaim(report);
		this.clearRetry(report.reportId);
		if (report.reportId) {
			this.pending.delete(report.reportId);
			this.noticesWaiting.delete(report.reportId);
		}
	}

	private removeClaim(report: Report): void {
		const claim = claims.get(report);
		if (claim) fs.rmSync(claim.claim, { force: true });
		claims.delete(report);
	}

	/** The report did not reach Octocode: it goes back to the pending folder, and may be queued again when taken. */
	private retain(report: Report): void {
		this.clearRetry(report.reportId);
		if (report.reportId !== undefined) {
			this.pending.delete(report.reportId);
			this.noticesWaiting.delete(report.reportId);
		}
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

/** The notice for a parent mid-turn. The path is the saved full report when the report was long enough to be saved. */
export function noticeText(report: Report): string {
	const { id, outcome, status } = report.details;
	const result = outcome ?? (status === "done" ? "finished" : status);
	// The pointer is the last such line, after anything the child wrote; only a scratch path is ever repeated.
	// The host's own report file: the report text is the child's, and may imitate a pointer line.
	const saved = report.details.reportArtifact?.path;
	const file = saved ? shortPath(saved) : undefined;
	return renderInstruction("notices/subagents/report-waiting.md", { id, result, file });
}
