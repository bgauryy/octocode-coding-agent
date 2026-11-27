/** The deadline one feature's `session_shutdown` handler gets before the features after it run. */

import type { FeatureError } from "../types.ts";

/**
 * Longest one feature's `session_shutdown` handler holds the features after it and the session switch or quit it is part
 * of: handlers run one after another, so a hanging one (a server that never answers a close) would block every later
 * feature's cleanup. Generous, since a handler may flush state to disk.
 */
export const SHUTDOWN_HANDLER_TIMEOUT_MS = 10_000;

const LATE = Symbol("late");

/**
 * Waits for a `session_shutdown` handler up to `ms`. Past it, reports the handler as late and returns undefined; the
 * handler keeps running, and a later failure is reported too, so no error is lost.
 */
export async function withinShutdownDeadline<T>(
	run: Promise<T>,
	source: string,
	emitError: (error: FeatureError) => void,
	ms = SHUTDOWN_HANDLER_TIMEOUT_MS,
): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const outcome = await Promise.race([
			run,
			new Promise<typeof LATE>((resolve) => {
				timer = setTimeout(() => resolve(LATE), ms);
			}),
		]);
		if (outcome !== LATE) return outcome;
		emitError({
			source,
			event: "session_shutdown",
			error: `session_shutdown handler did not finish within ${ms / 1000}s; the features after it ran without waiting`,
		});
		run.catch((err: unknown) =>
			emitError({
				source,
				event: "session_shutdown",
				error: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
			}),
		);
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}
