import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { RATE_LIMIT_WINDOW_MS, retryAfterBeyondCap, retryAssistantCall, retryDelayFor } from "../src/utils/retry.ts";

const policy = { baseDelayMs: 2_000, maxAgentDelayMs: 60_000, maxRetries: 3 };
const rateLimited = (retryAfterMs?: number) => ({ errorMessage: "429 rate_limit_error", retryAfterMs });

describe("a provider's retry-after", () => {
	it("is waited out in full up to the cap, the cap bounding only this side's backoff and spread", () => {
		expect(retryDelayFor(policy, 1, rateLimited(45_000), 0, () => 0)).toBe(45_000);
		// The spread over the provider's wait stays under the cap; the provider's own wait never shrinks to it.
		expect(retryDelayFor(policy, 1, rateLimited(59_500), 0, () => 1)).toBe(60_000);
		expect(retryDelayFor({ baseDelayMs: 2_000, maxRetries: 3 }, 1, rateLimited(59_500), 0, () => 1)).toBe(60_000);
		expect(retryDelayFor({ ...policy, maxAgentDelayMs: 40 }, 1, rateLimited(5_000), 0, () => 0)).toBe(5_000);
		// Without one, the backoff applies as before.
		expect(retryDelayFor(policy, 1, rateLimited(), 0, () => 0)).toBe(2_000);
	});

	it("is a floor for any retryable failure, and for an attempt the window pulls in", () => {
		expect(retryDelayFor(policy, 1, { errorMessage: "500 internal server error", retryAfterMs: 9_000 }, 0)).toBe(9_000);
		expect(retryDelayFor(policy, 5, rateLimited(50_000), RATE_LIMIT_WINDOW_MS - 5, () => 0)).toBe(50_000);
	});

	it("past the cap makes the failure final at once and says how long the provider asked", () => {
		expect(retryAfterBeyondCap(policy, { retryAfterMs: 60_000 })).toBeUndefined();
		expect(retryAfterBeyondCap(policy, {})).toBeUndefined();
		expect(retryAfterBeyondCap(policy, { retryAfterMs: 300_000 })).toMatch(
			/asked to wait 300s.*maxAgentDelayMs \(60s\)/,
		);
		// Unset, the cap is the 60 s default.
		expect(retryAfterBeyondCap({}, { retryAfterMs: 61_000 })).toMatch(/61s/);
	});

	it("past the cap ends a retried call without sleeping, naming the wait on the final message", async () => {
		vi.useFakeTimers();
		try {
			const produce = vi.fn(async () => ({
				...fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too Many Requests" }),
				retryAfterMs: 120_000,
			}));
			const onRetryScheduled = vi.fn();
			const result = await retryAssistantCall(produce, { enabled: true, ...policy }, undefined, { onRetryScheduled });
			expect(produce).toHaveBeenCalledTimes(1);
			expect(onRetryScheduled).not.toHaveBeenCalled();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/^429 Too Many Requests\nThe provider asked to wait 120s/);
		} finally {
			vi.useRealTimers();
		}
	});

	it("within the cap is slept out before the retry goes", async () => {
		vi.useFakeTimers();
		try {
			let n = 0;
			const produce = vi.fn(async () =>
				++n === 1
					? {
							...fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 Too Many Requests" }),
							retryAfterMs: 50_000,
						}
					: fauxAssistantMessage("done"),
			);
			const onRetryScheduled = vi.fn();
			const settled = retryAssistantCall(produce, { enabled: true, ...policy, maxAgentDelayMs: 55_000 }, undefined, {
				onRetryScheduled,
			});
			await vi.advanceTimersByTimeAsync(49_999);
			expect(produce).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(2_000);
			expect((await settled).stopReason).toBe("stop");
			expect(onRetryScheduled.mock.calls[0]?.[2]).toBeGreaterThanOrEqual(50_000);
		} finally {
			vi.useRealTimers();
		}
	});
});
