import { createAbortError } from "../utils/abort.ts";
import type { AssistantMessage } from "../types.ts";

type CompletedStopReason = Exclude<AssistantMessage["stopReason"], "pending" | "aborted" | "error">;

/** How one adapter words a stream that settled without a usable stop reason. */
export interface StreamCompletionWording {
	/** Names the provider in the missing-stop-reason error, as in "Anthropic stream ended without a stop reason". */
	label: string;
	/** The provider's own term for the terminal field. Defaults to "stop reason". */
	missing?: "stop reason" | "finish reason";
	/** Builds the error text for an `aborted` or `error` stop; defaults to the output's error message. */
	failureMessage?: (output: AssistantMessage) => string;
}

/**
 * Throws unless a stream ended with a successful stop reason: an aborted signal raises an abort error,
 * a `pending` stop names the provider, and an `aborted` or `error` stop raises its message.
 */
export function assertStreamCompleted(
	output: AssistantMessage,
	signal: AbortSignal | undefined,
	wording: StreamCompletionWording | string,
): asserts output is AssistantMessage & { stopReason: CompletedStopReason } {
	const { label, missing = "stop reason", failureMessage } = typeof wording === "string" ? { label: wording } : wording;
	if (signal?.aborted) {
		throw createAbortError();
	}
	if (output.stopReason === "pending") {
		throw new Error(`${label} stream ended without a ${missing}`);
	}
	if (output.stopReason === "aborted" || output.stopReason === "error") {
		throw new Error(failureMessage ? failureMessage(output) : output.errorMessage || "An unknown error occurred");
	}
}

/** Fields adapters keep on content blocks only while a stream is being parsed. */
const STREAM_SCRATCH_FIELDS = ["index", "partialJson", "partialArgs", "customInput", "streamIndex"] as const;

/** Removes streaming scratch state from content blocks so it is never persisted or replayed. */
export function stripStreamScratch(output: AssistantMessage): void {
	for (const block of output.content) {
		const scratch = block as Partial<Record<(typeof STREAM_SCRATCH_FIELDS)[number], unknown>>;
		for (const field of STREAM_SCRATCH_FIELDS) delete scratch[field];
	}
}
