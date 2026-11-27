import type { FeatureHost, SessionCompactFailedEvent } from "../features/index.ts";
import type { SessionInternals } from "./host.ts";
import { recordRunFailure } from "./run-outcome.ts";

/** Tells features a compaction failed or was cancelled (`session_compact_failed`), when any listens. */
export async function emitCompactFailed(
	runner: FeatureHost,
	event: Omit<SessionCompactFailedEvent, "type">,
): Promise<void> {
	if (runner.hasHandlers("session_compact_failed")) {
		await runner.emit({
			type: "session_compact_failed",
			...event,
		});
	}
}

/**
 * Overflow recovery hid the failed attempt and then could not compact: report it, as a failed recovery would be,
 * instead of ending the run without an explanation.
 */
export async function reportRecoveryNotStarted(
	host: Pick<SessionInternals, "session" | "run" | "emit">,
	cause: string,
): Promise<void> {
	const errorMessage = `Context overflow recovery failed: ${cause}. Try reducing context or switching to a larger-context model.`;
	recordRunFailure(host.run.outcome, errorMessage);
	host.emit({
		type: "compaction_end",
		reason: "overflow",
		result: undefined,
		aborted: false,
		willRetry: false,
		errorMessage,
	});
	await emitCompactFailed(host.session.featureHost, {
		reason: "overflow",
		errorMessage,
		aborted: false,
		willRetry: false,
		fromFeature: false,
	});
}

/** Automatic compaction is switched off after repeated failures: says so once, and tells features an overflow was not recovered. */
export async function reportAutoCompactionStopped(
	host: Pick<SessionInternals, "session" | "emit">,
	reason: "overflow" | "threshold",
): Promise<void> {
	const errorMessage =
		"Automatic compaction stopped after three consecutive failures. Resolve the error and run /compact, or start a new session.";
	host.emit({ type: "compaction_end", reason, result: undefined, aborted: false, willRetry: false, errorMessage });
	// An overflow's failed reply is already out of the context: features hear that it was not recovered. The run
	// keeps the failure the provider reported for it.
	if (reason === "overflow")
		await emitCompactFailed(host.session.featureHost, {
			reason,
			errorMessage,
			aborted: false,
			willRetry: false,
			fromFeature: false,
		});
}
