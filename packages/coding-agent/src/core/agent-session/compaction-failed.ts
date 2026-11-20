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
