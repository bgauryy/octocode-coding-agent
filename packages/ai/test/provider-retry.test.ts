import { APICallError } from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { retryAfterMsFromError, retryProviderRequest } from "../src/utils/provider-retry.ts";
import { RetryDelayExceededError } from "../src/utils/retry.ts";

function providerError(status: number | undefined, headers?: Record<string, string>): Error {
	return Object.assign(new Error(`Provider error: ${status}`), {
		status,
		headers: new Headers(headers),
	});
}

describe("provider request retries", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries retryable provider errors", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after-ms": "1000" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});
	it("honors Vercel SDK retry metadata without changing the thrown error", async () => {
		vi.useFakeTimers();
		const error = new APICallError({
			message: "rate limited",
			url: "https://provider.example",
			requestBodyValues: {},
			statusCode: 429,
			responseHeaders: { "retry-after-ms": "1000" },
		});
		const request = vi.fn<() => Promise<string>>().mockRejectedValueOnce(error).mockResolvedValue("ok");
		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(result).resolves.toBe("ok");
		expect(retryAfterMsFromError(error)).toBe(1000);
	});
	it("respects Vercel SDK non-retryable network failures", async () => {
		const error = new APICallError({
			message: "invalid request",
			url: "https://provider.example",
			requestBodyValues: {},
			isRetryable: false,
		});
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);
		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry errors the provider marks as non-retryable", async () => {
		const error = providerError(429, { "x-should-retry": "false" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry statuses listed in noRetryStatuses", async () => {
		const error = providerError(504, { "retry-after-ms": "0" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2, noRetryStatuses: [504] })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects a provider-requested retry delay above the limit", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 277403s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("allows disabling the provider-requested retry delay cap", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after": "2" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 0 });
		await vi.advanceTimersByTimeAsync(1999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("aborts a provider-requested retry delay", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		const result = retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 0, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("RetryDelayExceededError", () => {
	it("keeps the response's headers, so the session retry can still read what the provider asked for", async () => {
		const request = vi.fn(async () => {
			throw providerError(503, { "retry-after": "300" });
		});
		const failure = await retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 }).catch(
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(RetryDelayExceededError);
		expect(retryAfterMsFromError(failure)).toBe(300_000);
	});
});

describe("retryAfterMsFromError", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("reads retry-after-ms before retry-after", () => {
		expect(retryAfterMsFromError(providerError(429, { "retry-after-ms": "1500", "retry-after": "9" }))).toBe(1500);
	});

	it("converts retry-after seconds and HTTP dates", () => {
		expect(retryAfterMsFromError(providerError(429, { "retry-after": "12" }))).toBe(12_000);
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		expect(retryAfterMsFromError(providerError(429, { "retry-after": "Thu, 01 Jan 2026 00:00:30 GMT" }))).toBe(30_000);
	});

	it("returns undefined without a usable header or for non-provider errors", () => {
		expect(retryAfterMsFromError(providerError(429))).toBeUndefined();
		expect(retryAfterMsFromError(providerError(429, { "retry-after": "0" }))).toBeUndefined();
		expect(retryAfterMsFromError(providerError(429, { "retry-after": "soon" }))).toBeUndefined();
		expect(retryAfterMsFromError(new Error("plain"))).toBeUndefined();
		expect(retryAfterMsFromError("429")).toBeUndefined();
	});
});

describe("retryAfterMsFromError beyond fetch headers", () => {
	it("reads AWS SDK errors' raw response headers", () => {
		const error = Object.assign(new Error("throttled"), { $response: { headers: { "retry-after": "3" } } });
		expect(retryAfterMsFromError(error)).toBe(3000);
	});

	it("reads Google's RetryInfo delay from a headers-less SDK error", () => {
		const message = JSON.stringify({ error: { details: [{ retryDelay: "0.5s" }] } });
		expect(retryAfterMsFromError(Object.assign(new Error(message), { status: 429 }))).toBe(500);
	});
});
