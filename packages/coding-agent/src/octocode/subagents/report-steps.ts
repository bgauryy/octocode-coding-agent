import type { AgentRuns } from "./claim.ts";
import type { AwaitedReply } from "./linger.ts";
import type { RunDetails } from "./run-types.ts";

/** Whom the run's unanswered asks wait on: its parent (`asks`) first, else its peers (the team's record); it lingers while they wait. */
export function awaitedReply(runs: AgentRuns, id: string, details: RunDetails): AwaitedReply | undefined {
	if (details.asks?.some((ask) => !ask.answer)) return "parent";
	// An unreadable team database counts no peer asks (`Team.unansweredPeerAsks`), leaving the parent's record to decide.
	return runs.team.unansweredPeerAsks(id) > 0 ? "peer" : undefined;
}

/**
 * The report answers whatever the parent asked this child and it read: they stop counting as unanswered. Housekeeping on
 * the way to the report, so a failure here costs at most a stale notice and never the report.
 */
export async function closeAnswered(runs: AgentRuns, id: string): Promise<void> {
	try {
		await runs.team.closeQuestionsTo(id);
	} catch {
		// The questions stay open; the report is delivered either way.
	}
}

/**
 * What the child sent before it finished goes to the parent's model before its report: the mail tick may be up to a second
 * away, and a parent that ends with the report (a headless run) would never read it. Fails open like `closeAnswered`.
 */
export function readMailFirst(runs: AgentRuns): void {
	try {
		runs.team.deliverMail();
	} catch {
		// The next tick delivers it.
	}
}
