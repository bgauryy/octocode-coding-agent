import { afterEach, describe, expect, it, vi } from "vitest";
import { isRetryableError } from "../src/api/openai-codex-responses/retry.ts";
import { mapCodexEvents } from "../src/api/openai-codex-responses/events.ts";
import { parseSSE } from "../src/api/openai-codex-responses/sse.ts";
import { createAbortError } from "../src/utils/abort.ts";
import { iterateSseMessages, throwOnSseErrorEvent } from "../src/utils/server-sent-events.ts";
import {
	DEFAULT_MAX_RETRY_DELAY_MS,
	isTerminalProviderLimitError,
	parseRetryAfterMs,
	RetryDelayExceededError,
	validateRetryDelayMs,
} from "../src/utils/retry.ts";
import type { AssistantMessage, Model } from "../src/types.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("terminal provider limits", () => {
	it.each([
		"subscription_sharing_usage_limit_exceeded",
		"insufficient_quota",
		"GoUsageLimitError",
		"Monthly usage limit reached",
	])("treats %s as final on the shared classifier and on a Codex 429", (text) => {
		expect(isTerminalProviderLimitError(text)).toBe(true);
		expect(isRetryableError(429, text)).toBe(false);
	});

	it("still retries an ordinary 429", () => {
		expect(isTerminalProviderLimitError("slow down")).toBe(false);
		expect(isRetryableError(429, "slow down")).toBe(true);
	});
});

describe("parseRetryAfterMs", () => {
	const parse = (headers: Record<string, string>) => parseRetryAfterMs(new Headers(headers));

	it("reads retry-after-ms before retry-after", () => {
		expect(parse({ "retry-after-ms": "1500", "retry-after": "9" })).toBe(1500);
	});

	it("reads retry-after as seconds, including fractions", () => {
		expect(parse({ "retry-after": "12" })).toBe(12_000);
		expect(parse({ "retry-after": "1.5" })).toBe(1500);
	});

	it("reads retry-after as an HTTP date", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		expect(parse({ "retry-after": "Thu, 01 Jan 2026 00:00:30 GMT" })).toBe(30_000);
	});

	it("clamps negative values and past dates to zero", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
		expect(parse({ "retry-after-ms": "-5" })).toBe(0);
		expect(parse({ "retry-after": "-3" })).toBe(0);
		expect(parse({ "retry-after": "Thu, 01 Jan 2026 00:00:30 GMT" })).toBe(0);
	});

	it("ignores empty, suffixed, non-finite and missing values", () => {
		expect(parse({ "retry-after-ms": "" })).toBeUndefined();
		expect(parse({ "retry-after-ms": "  " })).toBeUndefined();
		expect(parse({ "retry-after": "5s" })).toBeUndefined();
		expect(parse({ "retry-after": "soon" })).toBeUndefined();
		expect(parse({ "retry-after": "1e999" })).toBeUndefined();
		expect(parse({})).toBeUndefined();
		expect(parseRetryAfterMs(undefined)).toBeUndefined();
	});

	it("falls through an unusable retry-after-ms to retry-after", () => {
		expect(parse({ "retry-after-ms": "", "retry-after": "3" })).toBe(3000);
	});

	it("returns a huge finite value so the delay limit can reject it", () => {
		const delayMs = parse({ "retry-after": "999999999" });
		expect(delayMs).toBe(999_999_999_000);
		expect(() => validateRetryDelayMs(delayMs as number, undefined)).toThrow(RetryDelayExceededError);
	});
});

describe("validateRetryDelayMs", () => {
	it("defaults to the 60 s limit", () => {
		expect(DEFAULT_MAX_RETRY_DELAY_MS).toBe(60_000);
		expect(validateRetryDelayMs(60_000)).toBe(60_000);
		expect(() => validateRetryDelayMs(60_001)).toThrow("Server requested 61s retry delay (max: 60s).");
	});

	it("honours an explicit limit, a disabled limit and the provider detail", () => {
		expect(() => validateRetryDelayMs(2000, 1000, "Overloaded")).toThrow(
			"Server requested 2s retry delay (max: 1s). Overloaded",
		);
		expect(validateRetryDelayMs(10 * 60_000, 0)).toBe(600_000);
	});
});

describe("createAbortError", () => {
	it("is an AbortError with the shared message", () => {
		const error = createAbortError();
		expect(error.name).toBe("AbortError");
		expect(error.message).toBe("Request was aborted");
		expect(createAbortError("stopped").message).toBe("stopped");
	});
});

describe("SSE error frames", () => {
	const frame = (text: string) => new Response(text).body as ReadableStream<Uint8Array>;

	it("throws the raw text of an error frame for the shared readers", async () => {
		const read = async () => {
			for await (const event of iterateSseMessages(frame("event: error\ndata: gateway failure\n\n"))) {
				throwOnSseErrorEvent(event);
			}
		};
		await expect(read()).rejects.toThrow("gateway failure");
	});

	it("parses a Codex frame named error as a payload that keeps its code", async () => {
		const body = 'event: error\ndata: {"type":"error","code":"usage_limit_reached","message":"limit"}\n\n';
		const events = mapCodexEvents(
			parseSSE(new Response(body)),
			{ content: [] } as unknown as AssistantMessage,
			{} as Model<"openai-codex-responses">,
			undefined,
		);
		await expect(events.next()).rejects.toMatchObject({ code: "usage_limit_reached" });
	});
});
