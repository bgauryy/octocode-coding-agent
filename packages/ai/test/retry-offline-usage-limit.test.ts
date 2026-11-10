import { describe, expect, it } from "vitest";
import { normalizeProviderError } from "../src/utils/error-body.ts";
import {
	isOfflineText,
	isRetryableErrorText,
	isUsageLimitError,
	mayRetry,
	OFFLINE_MAX_GAP_MS,
	OFFLINE_WINDOW_MS,
	RATE_LIMIT_WINDOW_MS,
	retryDelayFor,
} from "../src/utils/retry.ts";

const policy = { baseDelayMs: 2000, maxAgentDelayMs: 60_000, maxRetries: 3 };

describe("usage limits", () => {
	it.each([
		"subscription_sharing_usage_limit_exceeded",
		"Monthly usage limit reached",
		"429 quota exceeded for this month",
		"insufficient_quota",
		"402 Payment Required",
		"Insufficient account funds",
		"You are out of credit",
	])("classifies %s as a usage limit", (text) => {
		expect(isUsageLimitError(text)).toBe(true);
	});

	it.each(["429 rate limit, slow down", "400 max_tokens: 150000", "overloaded", "id toolu_01Ab402xYz"])(
		"does not classify %s as a usage limit",
		(text) => {
			expect(isUsageLimitError(text)).toBe(false);
		},
	);
});

describe("no-route network failures", () => {
	it.each([
		"fetch failed (ENETUNREACH)",
		"connect EHOSTUNREACH 10.0.0.1:443",
		"ENETDOWN",
		"getaddrinfo EAI_AGAIN api.x",
	])("retries %s past the configured count inside the 10-minute window", (text) => {
		expect(isOfflineText(text)).toBe(true);
		expect(isRetryableErrorText(text)).toBe(true);
		expect(mayRetry(10, 3, text, RATE_LIMIT_WINDOW_MS + 60_000)).toBe(true);
		expect(mayRetry(10, 3, text, OFFLINE_WINDOW_MS)).toBe(false);
	});

	it("waits at most 30 seconds between attempts and never past the window", () => {
		const failure = { errorMessage: "fetch failed (ENETUNREACH)" };
		for (let attempt = 1; attempt <= 12; attempt++) {
			expect(retryDelayFor(policy, attempt, failure, 0, () => 1)).toBeLessThanOrEqual(OFFLINE_MAX_GAP_MS);
		}
		expect(retryDelayFor(policy, 12, failure, OFFLINE_WINDOW_MS - 5_000, () => 1)).toBe(5_000);
	});

	it("keeps ENOTFOUND to the configured retries: a mistyped host never resolves", () => {
		const text = "getaddrinfo ENOTFOUND api.example.invalid";
		expect(isOfflineText(text)).toBe(false);
		expect(mayRetry(3, 3, text, 0)).toBe(true);
		expect(mayRetry(4, 3, text, 0)).toBe(false);
	});

	it("puts the cause's system error code into a fetch error's text", () => {
		const cause = Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" });
		const wrapped = new TypeError("fetch failed", { cause: new Error("socket", { cause }) });
		expect(normalizeProviderError(wrapped).message).toBe("fetch failed (ENETUNREACH)");
		const named = Object.assign(new Error("connect EHOSTUNREACH 10.0.0.1"), { code: "EHOSTUNREACH" });
		expect(normalizeProviderError(named).message).toBe("connect EHOSTUNREACH 10.0.0.1");
	});
});
