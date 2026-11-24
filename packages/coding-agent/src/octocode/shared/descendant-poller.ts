import { sharedClock } from "@octocodeai/octocode-common/clock";
import { descendantRows } from "./process-descendants.ts";
import { PS_CACHE_MS } from "./ps-snapshot.ts";
import type { ProcessRow } from "./process-table.ts";

/**
 * How often the tree is read: a helper that lives for less is not owned. Just past the shared table's cache window, so
 * each tick is a new sample rather than a repeat of the last one, at about one `ps` a second instead of one per tick.
 */
const DESCENDANT_POLL_MS = PS_CACHE_MS + 100;

/** The descendants of one process seen since the poller started. */
export interface DescendantPoller {
	/** One reading now, without stopping; every descendant seen so far. */
	snapshot(): Promise<ProcessRow[]>;
	/** Stops polling, takes one last reading, and returns every descendant seen, each once. */
	stop(): Promise<ProcessRow[]>;
}

/**
 * Reads `pid`'s descendants every `DESCENDANT_POLL_MS` from the shared process table (no extra `ps`; `snapshot` and
 * `stop` take a fresh read, since they feed a decision) and keeps each by pid and start time, so a helper that
 * reparents after its parent exits is still known, and a pid that a later process reuses is a different entry.
 * One reading runs at a time; a failed reading adds nothing.
 */
export function pollDescendants(pid: number | undefined, intervalMs = DESCENDANT_POLL_MS): DescendantPoller {
	const seen = new Map<string, ProcessRow>();
	let reading: Promise<void> = Promise.resolve();
	let stopped = false;
	const readOnce = async (fresh: boolean): Promise<void> => {
		const rows = await descendantRows(pid, false, { fresh }).catch((): ProcessRow[] => []);
		for (const row of rows) seen.set(`${row.pid}:${row.started ?? ""}`, row);
	};
	const read = (fresh: boolean): Promise<void> => {
		reading = reading.then(() => readOnce(fresh));
		return reading;
	};
	void read(false);
	const stopTimer = sharedClock.subscribe(
		() => {
			if (!stopped) void read(false);
		},
		{ everyMs: intervalMs },
	);
	return {
		async snapshot() {
			await read(true);
			return [...seen.values()];
		},
		async stop() {
			stopped = true;
			stopTimer();
			await read(true);
			return [...seen.values()];
		},
	};
}
