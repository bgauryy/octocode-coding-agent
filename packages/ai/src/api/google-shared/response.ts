import { FinishReason, type GenerateContentResponseUsageMetadata } from "@google/genai";
import type { StopReason, StreamOptions, Usage } from "../../types.ts";
import { createUsage } from "../../utils/assistant-message.ts";
import { retryProviderRequest } from "../../utils/provider-retry.ts";

/**
 * Map Gemini FinishReason to our StopReason.
 */
export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case FinishReason.STOP:
			return "stop";
		case FinishReason.MAX_TOKENS:
		case FinishReason.CONTINUATION:
			// CONTINUATION: stopped at the per-request token limit before finishing (SDK automatic continuation off or exhausted).
			return "length";
		case FinishReason.BLOCKLIST:
		case FinishReason.PROHIBITED_CONTENT:
		case FinishReason.SPII:
		case FinishReason.SAFETY:
		case FinishReason.IMAGE_SAFETY:
		case FinishReason.IMAGE_PROHIBITED_CONTENT:
		case FinishReason.IMAGE_RECITATION:
		case FinishReason.IMAGE_OTHER:
		case FinishReason.RECITATION:
		case FinishReason.FINISH_REASON_UNSPECIFIED:
		case FinishReason.OTHER:
		case FinishReason.LANGUAGE:
		case FinishReason.MALFORMED_FUNCTION_CALL:
		case FinishReason.UNEXPECTED_TOOL_CALL:
		case FinishReason.TOO_MANY_TOOL_CALLS:
		case FinishReason.NO_IMAGE:
			return "error";
		default: {
			const _exhaustive: never = reason;
			throw new Error(`Unhandled stop reason: ${String(_exhaustive)}`);
		}
	}
}

/**
 * Run a Google GenAI SDK request with the shared provider retry policy
 * (408/409/429/5xx with backoff, honoring retry-after), mirroring how the
 * Anthropic and OpenAI adapters wrap their initial request in
 * retryProviderRequest. The SDK's ApiError has a `status` property but no
 * `headers` property, and retryProviderRequest only retries errors that carry
 * both, so normalize the error by adding the missing `headers` before
 * rethrowing.
 */
export function retryGoogleRequest<T>(
	request: () => Promise<T>,
	options?: Pick<StreamOptions, "maxRetries" | "maxRetryDelayMs" | "signal">,
): Promise<T> {
	return retryProviderRequest(
		async () => {
			try {
				return await request();
			} catch (error) {
				if (error instanceof Error && "status" in error && !("headers" in error)) {
					(error as { headers?: Headers }).headers = undefined;
				}
				throw error;
			}
		},
		{
			maxRetries: options?.maxRetries,
			maxRetryDelayMs: options?.maxRetryDelayMs,
			signal: options?.signal,
		},
	);
}

/** Normalize Google's inclusive prompt count into disjoint billing buckets. */
export function normalizeGoogleUsage(metadata: GenerateContentResponseUsageMetadata): Usage {
	const count = (value: number | undefined): number =>
		typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
	const reportedCache = count(metadata.cachedContentTokenCount);
	const prompt = metadata.promptTokenCount === undefined ? reportedCache : count(metadata.promptTokenCount);
	const cacheRead = Math.min(prompt, reportedCache);
	const reasoning = count(metadata.thoughtsTokenCount);
	const output = count(metadata.candidatesTokenCount) + reasoning;
	// Tool-use prompts (search, code execution results) are input beside the prompt, and in the reported total.
	const toolUse = count(metadata.toolUsePromptTokenCount);
	return createUsage({
		input: prompt - cacheRead + toolUse,
		output,
		cacheRead,
		reasoning,
		totalTokens: count(metadata.totalTokenCount),
	});
}
