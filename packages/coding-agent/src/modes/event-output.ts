import { isRawStdoutWritePending, waitForRawStdoutBackpressure } from "../core/output-guard.ts";

/** The fields of a session event the output path reads. */
interface OutputEvent {
	type: string;
	toolCallId?: string;
}

/**
 * Writes session events in order, keeping only the latest `tool_execution_update` of each call while a stdout write is
 * pending. A tool's updates do not wait for the reader (the tool runs on), and each is a whole snapshot, so a stalled
 * reader would otherwise queue every snapshot of a noisy command in memory for as long as it runs.
 */
export function createEventOutput<E extends OutputEvent>(write: (event: E) => void): (event: E) => void {
	const latest = new Map<string, E>();
	let draining = false;
	const flush = () => {
		for (const event of latest.values()) write(event);
		latest.clear();
	};
	const drainLater = () => {
		if (draining) return;
		draining = true;
		void waitForRawStdoutBackpressure()
			.then(flush, () => {
				// The write failure itself goes to whoever handles stdout failures; there is no reader to flush to.
			})
			.finally(() => {
				draining = false;
			});
	};
	return (event) => {
		if (event.type === "tool_execution_update" && event.toolCallId !== undefined && isRawStdoutWritePending()) {
			latest.set(event.toolCallId, event);
			drainLater();
			return;
		}
		// The end of a call carries its result: an update written after it would be out of order, and before it is stale.
		if (event.type === "tool_execution_end" && event.toolCallId !== undefined) latest.delete(event.toolCallId);
		flush();
		write(event);
	};
}

/**
 * The backpressure a run observes between agent events. Updates are exempt: the tool does not wait for them, and waiting
 * here would hold each update's snapshot in memory until stdout drains, which is what coalescing them is to avoid.
 * Once the run's `signal` aborts, it stops waiting: a reader that stopped reading must not hold cancellation, and the
 * few events left in an aborted run stay queued for stdout in order.
 */
export async function waitForEventBackpressure(event: OutputEvent, signal?: AbortSignal): Promise<void> {
	if (event.type === "tool_execution_update" || signal?.aborted) return;
	const drained = waitForRawStdoutBackpressure();
	if (!signal) return drained;
	// A write failure after the abort has its own handler (or none); it no longer belongs to this run.
	void drained.catch(() => {});
	let onAbort = () => {};
	const aborted = new Promise<void>((resolve) => {
		onAbort = resolve;
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		await Promise.race([drained, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
