import type OpenAI from "openai";
import type { StopReason, Usage } from "../../types.ts";

/** Maps terminal Responses usage onto the message usage, before cost is calculated. */
export function parseResponsesUsage(usage: OpenAI.Responses.ResponseUsage): Usage {
	const inputDetails = usage.input_tokens_details as
		| {
				cached_tokens?: number;
				cache_write_tokens?: number;
				cache_write_tokens_details?: { ttl_12h_tokens?: number };
		  }
		| undefined;
	const cachedTokens = inputDetails?.cached_tokens || 0;
	const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
	return {
		// OpenAI includes cached and cache-write tokens in input_tokens, so subtract both.
		input: Math.max(0, (usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
		output: usage.output_tokens || 0,
		cacheRead: cachedTokens,
		cacheWrite: cacheWriteTokens,
		...(inputDetails?.cache_write_tokens_details === undefined
			? {}
			: { cacheWrite12h: inputDetails.cache_write_tokens_details.ttl_12h_tokens ?? 0 }),
		reasoning: usage.output_tokens_details?.reasoning_tokens || 0,
		totalTokens: usage.total_tokens || 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function mapStopReason(
	status: OpenAI.Responses.ResponseStatus | undefined,
	incompleteReason?: string,
): { stopReason: StopReason; errorMessage?: string } {
	if (!status) return { stopReason: "stop" };
	switch (status) {
		case "completed":
			return { stopReason: "stop" };
		case "incomplete":
			if (incompleteReason === "max_output_tokens") {
				return { stopReason: "length" };
			}
			return {
				stopReason: "error",
				errorMessage: incompleteReason
					? `Response incomplete: ${incompleteReason}`
					: "Response incomplete without a provider reason",
			};
		case "failed":
		case "cancelled":
			return { stopReason: "error" };
		// These two are wonky ...
		case "in_progress":
		case "queued":
			return { stopReason: "stop" };
		default: {
			const _exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${String(_exhaustive)}`);
		}
	}
}
