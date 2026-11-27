import { contentText, isRateLimitedText, isUsageLimitError } from "@octocodeai/octocode-ai";
import type { AssistantMessage, Model } from "@octocodeai/octocode-ai/compat";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { UsagePersistenceError } from "../usage-totals.ts";
import { SUMMARY_MAX_OUTPUT_TOKENS } from "./settings.ts";

/**
 * Returns an error message when a summarization response cannot safely be persisted.
 * A length stop or a cancel (providers return `aborted` rather than throwing) leaves partial text, which must not
 * become a session checkpoint.
 */
export function getSummarizationFailure(response: AssistantMessage, label: string): string | undefined {
	if (response.stopReason === "aborted") {
		return `${label} was cancelled`;
	}
	if (response.stopReason === "error") {
		return `${label} failed: ${response.errorMessage || "Unknown error"}`;
	}
	if (response.stopReason === "length") {
		return `${label} failed: generation hit the token cap and the summary is incomplete (output ${response.usage.output} tokens)`;
	}
	if (!response.content.some((block) => block.type === "toolCall") && !contentText(response.content).trim()) {
		return `${label} failed: the summary was empty`;
	}
	return undefined;
}

/**
 * A summary that stopped at the model's own output limit after every shrinking retry: the same model cannot write it, so
 * the compaction fails with this instead of sending the same request again on another path.
 */
export class SummaryOutputLimitError extends Error {}

/** The retry policy already handled a provider limit. Changing the summary prompt cannot lift it. */
export class SummaryProviderLimitError extends Error {}

/** Preserve a final throttle across summary fallback paths, including transports that reject with an exception. */
export function summaryProviderLimit(text: string | undefined): SummaryProviderLimitError | undefined {
	return text && (isRateLimitedText(text) || isUsageLimitError(text)) ? new SummaryProviderLimitError(text) : undefined;
}

/** A transport may throw instead of returning an assistant error. Usage recording failures keep their own recovery. */
export function rethrowSummaryRequestError(error: unknown): never {
	if (error instanceof UsagePersistenceError) throw error;
	throw summaryProviderLimit(errorMessage(error)) ?? error;
}

/** Whether `model`'s own output limit, not Octocode's summary cap, bounds every summary request to it. */
function ownLimitBinds(model: Pick<Model<any>, "maxTokens">): boolean {
	const own = model.maxTokens;
	return Number.isFinite(own) && own > 0 && own <= SUMMARY_MAX_OUTPUT_TOKENS;
}

/** The error a failed summary response throws; at the model's own output limit, a `SummaryOutputLimitError`. */
export function summaryFailure(
	response: AssistantMessage,
	label: string,
	model: Pick<Model<any>, "id" | "maxTokens">,
): Error | undefined {
	const failure = getSummarizationFailure(response, label);
	if (!failure) return undefined;
	if (response.stopReason === "error") return summaryProviderLimit(response.errorMessage) ?? new Error(failure);
	if (response.stopReason !== "length" || !ownLimitBinds(model)) return new Error(failure);
	return new SummaryOutputLimitError(
		`${failure}. ${model.maxTokens.toLocaleString("en-US")} tokens is ${model.id}'s own output limit, too small for this summary even when asked for a smaller one: switch to a model with a larger output limit, then compact.`,
	);
}
