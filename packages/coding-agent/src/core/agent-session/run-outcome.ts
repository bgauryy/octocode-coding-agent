import type { AssistantMessage } from "@octocodeai/octocode-ai/compat";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../usage-totals.ts";

/**
 * How a run ended, for anything that drives a session from outside. It is recorded from each assistant message as the
 * message finishes, because the context cannot answer the question: overflow recovery and retries remove failed
 * attempts from it, so the last message of a dead run can be the user's own.
 */
export interface RunOutcome {
	status: "completed" | "failed" | "aborted" | "truncated";
	/** The stop reason of the assistant message that decided a status other than `completed`. */
	stopReason?: AssistantMessage["stopReason"];
	/** Why the run failed: the provider's message, or the failed recovery that followed it. */
	errorMessage?: string;
	/**
	 * A provider failure as the retry lines name it (`<provider>/<model>[ at <host>]: <error>`, `retryFailureText`), for
	 * reports to people; `errorMessage` keeps the provider's own text, which retry classification reads. Absent when a
	 * failed recovery decided the status.
	 */
	failureText?: string;
	/** What went wrong around a run that still produced its result, such as a held message that could not be saved yet. */
	warning?: string;
	/** Every assistant message of the run, including failed attempts the context no longer holds. */
	usage: UsageTotals;
}

export function createRunOutcome(): RunOutcome {
	return { status: "completed", usage: createUsageTotals() };
}

/**
 * Folds one finished assistant message in: a later good message supersedes an earlier failure, as a retry does.
 * `failureText` names a provider failure for people (`SessionRetry.failureText`); without it the report shows the bare error.
 */
export function recordRunMessage(
	outcome: RunOutcome,
	message: AssistantMessage,
	failureText?: (message: AssistantMessage) => string,
): void {
	addUsageToTotals(outcome.usage, message.usage);
	const { stopReason } = message;
	outcome.failureText = undefined;
	if (stopReason === "error" || stopReason === "aborted") {
		outcome.status = stopReason === "error" ? "failed" : "aborted";
		outcome.stopReason = stopReason;
		outcome.errorMessage = message.errorMessage;
		if (stopReason === "error" && failureText) outcome.failureText = failureText(message);
	} else if (stopReason === "length") {
		outcome.status = "truncated";
		outcome.stopReason = stopReason;
		outcome.errorMessage = undefined;
	} else {
		outcome.status = "completed";
		outcome.stopReason = undefined;
		outcome.errorMessage = undefined;
	}
}

/** Names the failed recovery that left the run failed, which says more than the overflow error it tried to answer. */
export function recordRunFailure(outcome: RunOutcome, errorMessage: string): void {
	// A cut-off response is still what the run produced; its failed recovery does not make it a provider failure.
	if (outcome.status === "truncated") return;
	outcome.status = "failed";
	outcome.stopReason ??= "error";
	outcome.errorMessage = errorMessage;
	outcome.failureText = undefined;
}

export function recordRunWarning(outcome: RunOutcome, warning: string): void {
	outcome.warning = warning;
}

/** The outcome as reported when the run settles: an abort the user asked for wins over what the last message said. */
export function settledRunOutcome(outcome: RunOutcome, aborted: boolean): RunOutcome {
	if (!aborted) return { ...outcome, usage: { ...outcome.usage } };
	return { ...outcome, status: "aborted", stopReason: "aborted", usage: { ...outcome.usage } };
}
