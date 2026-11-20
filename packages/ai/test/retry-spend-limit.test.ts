import { APICallError } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { formatProviderError, normalizeProviderError } from "../src/utils/error-body.ts";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";
import { isRetryableErrorText, isUsageLimitError } from "../src/utils/retry.ts";

function apiError(statusCode: number, body: unknown, headers: Record<string, string> = {}): APICallError {
	const responseBody = JSON.stringify(body);
	return new APICallError({
		message: `${statusCode} ${responseBody}`,
		url: "https://example.test",
		requestBodyValues: {},
		statusCode,
		responseBody,
		responseHeaders: headers,
	});
}

/** OpenAI's documented 429 billing codes, sent without the `insufficient_quota` type the classifier already knew. */
const OPENAI_BILLING_CODES = [
	"credit_balance_exhausted",
	"organization_spend_limit_exceeded",
	"project_spend_limit_exceeded",
	"organization_usage_limit_exceeded",
];

/** Anthropic's tier spend cap, as its rate-limits page shows it: a 429 `rate_limit_error` with no `retry-after`. */
const ANTHROPIC_SPEND_CAP = {
	type: "error",
	error: {
		type: "rate_limit_error",
		message:
			"You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-12-01 at 00:00 UTC.",
		details: { error_code: "enforced_spend_limit_reached" },
	},
};

const cases = [
	...OPENAI_BILLING_CODES.map((code) => ({
		name: `OpenAI 429 ${code}`,
		error: () =>
			apiError(
				429,
				{ error: { message: "Request blocked.", type: "requests", param: null, code } },
				{
					"retry-after-ms": "1",
				},
			),
	})),
	{ name: "Anthropic 429 tier spend cap", error: () => apiError(429, ANTHROPIC_SPEND_CAP) },
	{
		name: "Anthropic 400 self-set workspace spend limit",
		error: () =>
			apiError(400, {
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "You have reached your specified workspace API usage limits. You will regain access on 2026-12-01.",
				},
			}),
	},
];

describe("documented spend and billing limits", () => {
	it.each(cases)("$name is a usage limit the session never retries", ({ error }) => {
		const text = formatProviderError(normalizeProviderError(error()));
		expect(isUsageLimitError(text)).toBe(true);
		expect(isRetryableErrorText(text)).toBe(false);
	});

	it.each(cases)("$name fails at once in the provider request retry", async ({ error }) => {
		const failure = error();
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(failure);
		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(failure);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("still retries Anthropic's ramp-limit 429, which clears after its retry-after", async () => {
		const failure = apiError(
			429,
			{
				type: "error",
				error: {
					type: "rate_limit_error",
					message: "Ramp limit exceeded.",
					details: { error_code: "ramp_limit_exceeded" },
				},
			},
			{ "retry-after": "0" },
		);
		const text = formatProviderError(normalizeProviderError(failure));
		expect(isUsageLimitError(text)).toBe(false);
		expect(isRetryableErrorText(text)).toBe(true);
		const request = vi.fn<() => Promise<string>>().mockRejectedValueOnce(failure).mockResolvedValue("ok");
		await expect(retryProviderRequest(request, { maxRetries: 2 })).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});
});
