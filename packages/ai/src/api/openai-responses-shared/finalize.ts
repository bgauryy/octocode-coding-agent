import { createAbortError } from "../../utils/abort.ts";
import type { AssistantMessage } from "../../types.ts";

type CompletedStopReason = Exclude<AssistantMessage["stopReason"], "pending" | "aborted" | "error">;

/**
 * Throws unless a Responses stream ended with a successful stop reason.
 * `label` names the provider in the missing-stop-reason error.
 */
export function assertResponsesStreamCompleted(
	output: AssistantMessage,
	signal: AbortSignal | undefined,
	label: string,
): asserts output is AssistantMessage & { stopReason: CompletedStopReason } {
	if (signal?.aborted) {
		throw createAbortError();
	}
	if (output.stopReason === "pending") {
		throw new Error(`${label} stream ended without a stop reason`);
	}
	if (output.stopReason === "aborted" || output.stopReason === "error") {
		throw new Error(output.errorMessage || "An unknown error occurred");
	}
}

/** Removes streaming scratch state from content blocks so it is never persisted or replayed. */
export function stripResponsesStreamScratch(output: AssistantMessage): void {
	for (const block of output.content) {
		delete (block as { index?: number }).index;
		delete (block as { partialJson?: string }).partialJson;
		delete (block as { customInput?: unknown }).customInput;
	}
}
