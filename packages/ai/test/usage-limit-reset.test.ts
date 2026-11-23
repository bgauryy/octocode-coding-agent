import { APICallError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { UsageLimitError, usageLimitResetAt } from "../src/index.ts";

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const NOW_S = Math.floor(NOW / 1000);

function apiError(body: string, headers: Record<string, string> = {}): APICallError {
	return new APICallError({
		message: `429 ${body}`,
		url: "https://api.example.com/v1/responses",
		requestBodyValues: undefined,
		statusCode: 429,
		responseHeaders: headers,
		responseBody: body,
	});
}

describe("usageLimitResetAt", () => {
	it("reads a Codex usage_limit_reached body's resets_at (seconds)", () => {
		const body = JSON.stringify({
			error: { type: "usage_limit_reached", message: "The usage limit has been reached", resets_at: NOW_S + 7200 },
		});
		expect(usageLimitResetAt(apiError(body), NOW)).toBe(NOW + 7_200_000);
		expect(usageLimitResetAt(body, NOW)).toBe(NOW + 7_200_000);
	});

	it("reads resets_in_seconds, reset_at in ms and an ISO reset time", () => {
		expect(usageLimitResetAt('{"error":{"resets_in_seconds":3600}}', NOW)).toBe(NOW + 3_600_000);
		expect(usageLimitResetAt(`{"reset_at":${NOW + 60_000}}`, NOW)).toBe(NOW + 60_000);
		expect(usageLimitResetAt('{"resetsAt":"2026-11-23T14:20:00Z"}', NOW)).toBe(Date.UTC(2026, 10, 23, 14, 20));
	});

	it("reads Anthropic's spend-cap date", () => {
		const text =
			"429 rate_limit_error: You have reached your API usage limits: your organization has crossed its monthly API usage threshold. You will regain access on 2026-12-01 at 00:00 UTC.";
		expect(usageLimitResetAt(text, NOW)).toBe(Date.UTC(2026, 11, 1));
	});

	it("falls back to the provider's retry-after header", () => {
		const error = apiError('{"error":{"type":"insufficient_quota"}}', { "retry-after": "120" });
		expect(usageLimitResetAt(error, NOW)).toBe(NOW + 120_000);
	});

	it("prefers the body's reset over retry-after", () => {
		const error = apiError(`{"error":{"resets_at":${NOW_S + 3600}}}`, { "retry-after": "5" });
		expect(usageLimitResetAt(error, NOW)).toBe(NOW + 3_600_000);
	});

	it("reads a failed assistant message's retryAfterMs and errorMessage", () => {
		expect(usageLimitResetAt({ stopReason: "error", errorMessage: "quota exceeded", retryAfterMs: 90_000 }, NOW)).toBe(
			NOW + 90_000,
		);
		expect(usageLimitResetAt({ errorMessage: `{"resets_at":${NOW_S + 60}}`, retryAfterMs: 5 }, NOW)).toBe(NOW + 60_000);
	});

	it("reads a wait stated in words", () => {
		expect(usageLimitResetAt("You've hit your usage limit. Try again in 2h13m.", NOW)).toBe(
			NOW + (2 * 60 + 13) * 60_000,
		);
		expect(usageLimitResetAt("Please try again in 3 hours and 20 minutes", NOW)).toBe(NOW + 200 * 60_000);
		expect(usageLimitResetAt("Rate limit reached. Please try again in 6m0s.", NOW)).toBe(NOW + 360_000);
	});

	it("reads the reset a UsageLimitError carries, also through a cause", () => {
		const limit = new UsageLimitError("usage quota exceeded", { resetsAt: NOW_S + 600, window: "five_hour" });
		expect(usageLimitResetAt(limit, NOW)).toBe(NOW + 600_000);
		expect(usageLimitResetAt(new Error("turn failed", { cause: limit }), NOW)).toBe(NOW + 600_000);
		expect(limit.window).toBe("five_hour");
	});

	it("is undefined when the failure names no time", () => {
		expect(usageLimitResetAt("insufficient_quota", NOW)).toBeUndefined();
		expect(usageLimitResetAt(new UsageLimitError("usage quota exceeded"), NOW)).toBeUndefined();
		expect(usageLimitResetAt(apiError('{"error":{"resets_at":null}}'), NOW)).toBeUndefined();
		expect(usageLimitResetAt(undefined, NOW)).toBeUndefined();
	});
});
