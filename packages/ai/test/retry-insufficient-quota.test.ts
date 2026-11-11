import { APIError } from "openai";
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { formatProviderError, normalizeProviderError } from "../src/utils/error-body.ts";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";
import { isRateLimitedText, isRetryableErrorText, isUsageLimitError, retryAssistantCall } from "../src/utils/retry.ts";

/** OpenAI's 429 for an account out of quota or credit: final until billing changes, unlike a rate limit. */
function insufficientQuota(message: string): APIError {
	return APIError.generate(
		429,
		{ error: { message, type: "insufficient_quota", param: null, code: "insufficient_quota" } },
		undefined,
		new Headers({ "retry-after-ms": "1" }),
	);
}

const OPENAI_TEXT = "You exceeded your current quota, please check your plan and billing details.";
/** Gateways relay the code with shorter text that names neither billing nor a quota phrase the classifier knows. */
const GATEWAY_TEXT = "You exceeded your current quota.";

function failed(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: 0,
	};
}

describe("OpenAI 429 insufficient_quota", () => {
	it.each([OPENAI_TEXT, GATEWAY_TEXT])("is a usage limit the session never retries: %s", async (text) => {
		const errorMessage = formatProviderError(normalizeProviderError(insufficientQuota(text)));
		expect(errorMessage).toContain("insufficient_quota");
		expect(isUsageLimitError(errorMessage)).toBe(true);
		expect(isRetryableErrorText(errorMessage)).toBe(false);

		const produce = vi.fn(async () => failed(errorMessage));
		const policy = { enabled: true, maxRetries: 3, baseDelayMs: 1 };
		await expect(retryAssistantCall(produce, policy, undefined)).resolves.toMatchObject({ stopReason: "error" });
		expect(produce).toHaveBeenCalledTimes(1);
	});

	it.each([OPENAI_TEXT, GATEWAY_TEXT])("fails at once in the provider request retry: %s", async (text) => {
		const error = insufficientQuota(text);
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("still retries a plain 429 rate limit in the provider request retry", async () => {
		const error = APIError.generate(
			429,
			{ error: { message: "Rate limit reached for requests", type: "requests", code: "rate_limit_exceeded" } },
			undefined,
			new Headers({ "retry-after-ms": "1" }),
		);
		expect(isRateLimitedText(error.message)).toBe(true);
		const request = vi.fn<() => Promise<string>>().mockRejectedValueOnce(error).mockResolvedValue("ok");

		await expect(retryProviderRequest(request, { maxRetries: 2 })).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});
});
