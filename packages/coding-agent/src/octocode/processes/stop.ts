import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { processMatch, stopTree } from "../shared/process.ts";
import type { Orphan } from "./classify.ts";

export interface StopDeps {
	/** The orphans as the records and the process table show them right now. */
	current: () => Promise<readonly Orphan[]>;
	match: (pid: number, started: string) => "same" | "other" | "unknown";
	/** SIGTERM, then SIGKILL after the grace period (`stopTree`). */
	stop: (pid: number) => Promise<void>;
}

export interface StopResult {
	pid: number;
	label: string;
	outcome: "stopped" | "skipped" | "failed";
	why?: string;
}

export const liveStopDeps = (current: StopDeps["current"]): StopDeps => ({
	current,
	match: (pid, started) => processMatch(pid, started),
	stop: (pid) => stopTree(pid),
});

/**
 * Stops the confirmed orphans, each only after four checks made just before the signal: the pid is signalable (not init,
 * not this process); a start time was recorded; the records, read again, still name it as an orphan with that start time
 * (so only a process an Octocode recorded as its own is ever a target); and the live process still has that start time
 * (a pid the system reused for something else is never signalled). Skips say why; one failure does not stop the rest.
 */
export async function stopOrphans(requested: readonly Orphan[], deps: StopDeps): Promise<StopResult[]> {
	const fresh = await deps.current();
	const results: StopResult[] = [];
	for (const target of requested) {
		const base = { pid: target.pid, label: target.label };
		const skip = (why: string): StopResult => ({ ...base, outcome: "skipped", why });
		if (!Number.isInteger(target.pid) || target.pid <= 1 || target.pid === process.pid) {
			results.push(skip("not a pid Octocode may signal"));
		} else if (!target.started) {
			results.push(skip("no start time was recorded for it"));
		} else if (!fresh.some((each) => each.pid === target.pid && each.started === target.started)) {
			results.push(skip("not an orphan any more"));
		} else {
			const match = deps.match(target.pid, target.started);
			if (match === "other") results.push(skip("the pid belongs to another process now"));
			else if (match === "unknown") results.push(skip("its start time could not be verified"));
			else {
				try {
					await deps.stop(target.pid);
					results.push({ ...base, outcome: "stopped" });
				} catch (error) {
					results.push({ ...base, outcome: "failed", why: errorMessage(error) });
				}
			}
		}
	}
	return results;
}
