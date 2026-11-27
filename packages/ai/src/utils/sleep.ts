import { sleepUnlessAborted } from "./abort.ts";

/** Wait `ms`, or reject with the signal's reason once it aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return sleepUnlessAborted(ms, signal, () => signal.reason);
}
