import type { RpcEvent, RpcEventListener } from "./types.ts";
import { reportToStderr } from "../../../../../common/src/stderr.ts";

/** Runs a listener or callback so that its exception is reported as its own failure, not taken for a bad line. */
export function guarded(what: string, run: () => void): void {
	try {
		run();
	} catch (error) {
		reportToStderr(`${what} failed`, error);
	}
}

/** Iterates a snapshot, so a listener that unsubscribes during dispatch does not change who hears this record. */
export function notifyAll<T>(what: string, listeners: ReadonlyArray<(value: T) => void>, value: T): void {
	for (const listener of Array.from(listeners)) guarded(what, () => listener(value));
}

/** The events up to `agent_settled`; rejects when the process closes first or `timeout` passes. */
export function collectUntilSettled(
	source: { onEvent(listener: RpcEventListener): () => void; onClose(listener: (error: Error) => void): () => void },
	timeout: number,
	timeoutMessage: () => string,
): Promise<RpcEvent[]> {
	return new Promise((resolve, reject) => {
		const events: RpcEvent[] = [];
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(timeoutMessage()));
		}, timeout);

		const unsubscribe = source.onEvent((event) => {
			events.push(event);
			if (event.type === "agent_settled") {
				cleanup();
				resolve(events);
			}
		});
		const unsubscribeClose = source.onClose((error) => {
			cleanup();
			reject(error);
		});
		function cleanup() {
			clearTimeout(timer);
			unsubscribe();
			unsubscribeClose();
		}
	});
}
