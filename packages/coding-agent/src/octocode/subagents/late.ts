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
	/** The take in progress, or the last one: the next starts after it, so two takes never claim the same file. */
	private taking: Promise<void> = Promise.resolve();
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
			void this.take();
			if (Date.now() >= until) this.stopPolling();
		});
		return first;
	}

	take(): Promise<void> {
		const dir = this.dir;
		const generation = this.generation;
		const next = this.taking.then(async () => {
			if (!dir || generation !== this.generation) return;
			const reports = await takePendingReports(dir);
			if (generation !== this.generation) {
				await releasePendingReports(reports);
				return;
			}
			for (const report of reports) this.runs.reports.add(report);
		});
		this.taking = next.catch(() => undefined);
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
