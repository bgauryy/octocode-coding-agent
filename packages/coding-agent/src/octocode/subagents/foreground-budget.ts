import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import type { SubagentOutcome } from "./process/outcome.ts";
import type { RunDetails } from "./run-types.ts";

/** What a foreground run does when it outlasts the foreground budget: the run goes on as a background child. */
export interface HandOver {
	/** How long the call waits for the child's report (milliseconds). */
	afterMs: number;
	/**
	 * The call returns with the child's id and the run becomes a background run of this session: its report arrives as a
	 * message, `/agents kill` stops it, and the controller that already runs it keeps working.
	 */
	takeOver(running: Promise<SubagentOutcome>, controller: AbortController): AgentToolResult<RunDetails>;
}

/** Settles with `work`, or with `SPENT` once `ms` passed first. */
export const SPENT = Symbol("foreground budget spent");

/** Waits for `work` at most `ms`; the timer never outlives the call. */
export async function untilBudget<T>(work: Promise<T>, ms: number): Promise<T | typeof SPENT> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<typeof SPENT>((resolve) => {
				timer = setTimeout(() => resolve(SPENT), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
