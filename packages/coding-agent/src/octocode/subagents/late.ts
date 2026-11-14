import { onSecond } from "../shared/clock.ts";
import type { AgentRuns } from "./claim.ts";
import { pendingReportsDir, releasePendingReports, takePendingReports } from "./handoff/pending.ts";
import { SUBAGENT_STOP_GRACE_MS } from "./process/outcome.ts";

/**
 * After a session starts, how long it keeps looking for reports of runs the previous runtime stopped (a reload): a
 * stop can take two SIGTERM graces (term, then kill) plus saving an isolated run's worktree. Each settled turn looks too.
 */
const LATE_REPORTS_MS = 4 * SUBAGENT_STOP_GRACE_MS;

/**
 * Reports of background runs that finished after this Octocode session last ended (a reload, a stop slower than the shutdown
 * wait) are saved for it: taken at its start, for a while after it, and after every settled turn.
 */
export class LateReports {
	private dir: string | undefined;
	private stopClock: (() => void) | undefined;
	/** Explicit takes remain ordered; timer ticks skip a scan while one is outstanding. */
	private taking: Promise<void> | undefined;
	private generation = 0;

	private readonly runs: AgentRuns;
	constructor(runs: AgentRuns) {
		this.runs = runs;
	}

	/** Takes the reports waiting for this Octocode session now (resolves when done), and again every second for a while. */
	start(sessionId: string): Promise<void> {
		this.generation++;
		this.dir = pendingReportsDir(sessionId);
		this.runs.reports.pendingDir = this.dir;
		const first = this.take();
		const until = Date.now() + LATE_REPORTS_MS;
		this.stopClock?.();
		this.stopClock = onSecond(() => {
			const ending = Date.now() >= until;
			// Keep a final scan after any slow take: a report may have arrived since its directory snapshot.
			if (!this.taking || ending) void this.take();
			if (ending) this.stopPolling();
		});
		return first;
	}

	take(): Promise<void> {
		const dir = this.dir;
		if (!dir) return Promise.resolve();
		const generation = this.generation;
		const next = (this.taking ?? Promise.resolve()).then(async () => {
			if (generation !== this.generation) return;
			const reports = await takePendingReports(dir);
			if (generation !== this.generation) {
				await releasePendingReports(reports);
				return;
			}
			for (const report of reports) this.runs.reports.add(report);
		});
		const settled = next
			.catch(() => undefined)
			.finally(() => {
				if (this.taking === settled) this.taking = undefined;
			});
		this.taking = settled;
		return next;
	}

	stop(): void {
		this.generation++;
		this.stopPolling();
		this.dir = undefined;
	}

	private stopPolling(): void {
		this.stopClock?.();
		this.stopClock = undefined;
	}
}
