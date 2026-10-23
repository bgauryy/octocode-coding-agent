import { STARTUP_RETRY_DELAY_MS, StartupError, type SubagentOutcome } from "./process/outcome.ts";
import { runChild } from "./process/run-child.ts";

export { type Identity, subagentProcessEnv } from "./process/env.ts";
export {
	ABORT_SETTLE_MS,
	exitReason,
	STARTUP_RETRY_DELAY_MS,
	StartupError,
	SUBAGENT_STOP_GRACE_MS,
	USER_STOP,
} from "./process/outcome.ts";
export { buildAgentArgs, type ChildSession, childSession, childSessionFile } from "./process/session.ts";

/** Resolves after `ms`, or early when `signal` aborts (a user stop must not wait out the delay). */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

/**
 * Runs one child (see `runChild`). A child that crashed while loading its code before any model turn is started once
 * more after a short delay: no tool ran, so nothing repeats. A stop (`signal`) is never retried.
 */
export async function runSubagent(...call: Parameters<typeof runChild>): Promise<SubagentOutcome> {
	try {
		return await runChild(...call);
	} catch (error) {
		const signal = call[5];
		if (!(error instanceof StartupError) || !error.retryable || signal?.aborted) throw error;
		await pause(STARTUP_RETRY_DELAY_MS, signal);
		if (signal?.aborted) throw new Error("Subagent cancelled");
		return runChild(...call);
	}
}
