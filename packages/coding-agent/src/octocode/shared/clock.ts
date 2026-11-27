import { sharedClock } from "@octocodeai/octocode-common/clock";

/** The cadence of `onSecond`. */
const SECOND_MS = 1_000;

/**
 * Calls `listener` every second until the returned function is called. Every listener shares the process-wide clock's
 * one unref'd timer, which runs only while one is subscribed: the team ticker, a subagent's parent check and the poll
 * for late reports each wake the event loop once a second, so together they wake it once. Every listener runs even when
 * an earlier one throws; the error is reported as an unhandled rejection, never thrown out of the timer.
 */
export function onSecond(listener: () => void): () => void {
	return onEvery(SECOND_MS, listener);
}

/** Like `onSecond`, about every `everyMs`: a slower listener is served on the same timer, never one of its own. */
export function onEvery(everyMs: number, listener: () => void): () => void {
	return sharedClock.subscribe(() => listener(), { everyMs });
}
