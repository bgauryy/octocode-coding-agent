import { entryUsage } from "../../core/usage-totals.ts";
import type { Settings } from "../../core/settings-schema.ts";
import { sessionChildren } from "../shared/session-children.ts";
import type { RunDetails } from "./run-types.ts";

/** What the limits read of the running subagents (`AgentRuns`). */
interface RunningChildren {
	running: ReadonlyMap<string, unknown>;
	live: ReadonlyMap<string, Pick<RunDetails, "cost">>;
}

const stillRunning = (runs: RunningChildren): string =>
	runs.running.size > 0
		? ` Running now, and left running: ${[...runs.running.keys()].join(", ")}.`
		: " None is running.";

/**
 * Why a new subagent may not start under the opt-in `subagents` limits, or undefined. Off unless configured, and a refusal
 * only: what runs keeps running and its report still arrives. `maxChildren` counts the children this session started,
 * a resume of one of them being no new child; `maxCost` is the session's recorded spend, its own and its finished
 * children's, plus what the running ones spent so far.
 */
export function spawnRefusal(
	limits: Settings["subagents"],
	entries: readonly Parameters<typeof entryUsage>[0][],
	runs: RunningChildren,
	resuming?: string,
): string | undefined {
	const { maxChildren, maxCost } = limits ?? {};
	if (maxChildren !== undefined && resuming === undefined) {
		const started = new Set([...sessionChildren(entries).map((child) => child.id), ...runs.running.keys()]);
		if (started.size >= maxChildren)
			return `Not started: this session has started ${started.size} subagents, and subagents.maxChildren is ${maxChildren}.${stillRunning(runs)} Do the work yourself, resume a finished child, or ask the user to raise the limit.`;
	}
	if (maxCost !== undefined) {
		let spent = 0;
		for (const entry of entries) spent += entryUsage(entry)?.usage.cost.total ?? 0;
		for (const details of runs.live.values()) spent += details.cost;
		if (spent >= maxCost)
			return `Not started: this session has spent $${spent.toFixed(2)}, and subagents.maxCost is $${maxCost.toFixed(2)}.${stillRunning(runs)} Do the work yourself, or ask the user to raise the limit.`;
	}
	return undefined;
}
