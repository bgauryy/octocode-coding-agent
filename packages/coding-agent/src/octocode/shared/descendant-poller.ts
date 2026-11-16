import { descendantRows } from "./process-descendants.ts";
import type { ProcessRow } from "./process-table.ts";

/** How often the tree is read: a helper that lives for less is not owned. */
const DESCENDANT_POLL_MS = 400;

/** The descendants of one process seen since the poller started. */
export interface DescendantPoller {
	/** One reading now, without stopping; every descendant seen so far. */
	snapshot(): Promise<ProcessRow[]>;
	/** Stops polling, takes one last reading, and returns every descendant seen, each once. */
	stop(): Promise<ProcessRow[]>;
}

/**
 * Reads `pid`'s descendants every `DESCENDANT_POLL_MS` and keeps each by pid and start time, so a helper that
 * reparents after its parent exits is still known, and a pid that a later process reuses is a different entry.
 * One reading runs at a time; a failed reading adds nothing.
 */
export function pollDescendants(pid: number | undefined, intervalMs = DESCENDANT_POLL_MS): DescendantPoller {
	const seen = new Map<string, ProcessRow>();
	let reading: Promise<void> = Promise.resolve();
	let stopped = false;
	const readOnce = async (): Promise<void> => {
		const rows = await descendantRows(pid).catch((): ProcessRow[] => []);
		for (const row of rows) seen.set(`${row.pid}:${row.started ?? ""}`, row);
	};
	const read = (): Promise<void> => {
		reading = reading.then(readOnce);
		return reading;
	};
	void read();
	const timer = setInterval(() => {
		if (!stopped) void read();
	}, intervalMs);
	timer.unref();
	return {
		async snapshot() {
			await read();
			return [...seen.values()];
		},
		async stop() {
			stopped = true;
			clearInterval(timer);
			await read();
			return [...seen.values()];
		},
	};
}
