import { type AssistantMessage, fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTERACTIVE_RETRY, retrySideCall } from "../../src/octocode/shared/side-retry.ts";

const failure = (errorMessage: string, retryAfterMs?: number): AssistantMessage => ({
	...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
	...(retryAfterMs === undefined ? {} : { retryAfterMs }),
});
const RATE_LIMITED = "429 Too Many Requests";

/** A produce that answers with each reply in turn, then the last one again. */
const replies = (...answers: AssistantMessage[]) => {
	const queue = [...answers];
	return vi.fn(async () => (queue.length > 1 ? queue.shift()! : queue[0]));
};

/** Runs the call to its end, firing every wait it schedules. */
async function settle<T>(pending: Promise<T>): Promise<T> {
	await vi.runAllTimersAsync();
	return pending;
}

describe("retrySideCall", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries a rate limit and a transient failure, then returns the success", async () => {
		const produce = replies(failure(RATE_LIMITED), failure("503 Service Unavailable"), fauxAssistantMessage("ok"));
		const reply = await settle(retrySideCall(produce, INTERACTIVE_RETRY, new AbortController().signal));
		expect(reply.stopReason).toBe("stop");
		expect(produce).toHaveBeenCalledTimes(3);
	});

	it("stops at its retry count even where the session retry would keep waiting out a rate limit", async () => {
		const produce = replies(failure(RATE_LIMITED));
		const reply = await settle(retrySideCall(produce, { retries: 1, maxWaitMs: 60_000 }, new AbortController().signal));
		expect(produce).toHaveBeenCalledTimes(2);
		expect(reply).toMatchObject({ stopReason: "error", errorMessage: RATE_LIMITED });
	});

	it("makes no retry whose wait would pass its total, such as a retry-after longer than the budget", async () => {
		const produce = replies(failure(RATE_LIMITED, 30_000));
		const started = Date.now();
		const reply = await settle(retrySideCall(produce, INTERACTIVE_RETRY, new AbortController().signal));
		expect(produce).toHaveBeenCalledTimes(1);
		expect(Date.now() - started).toBe(0);
		expect(reply).toMatchObject({ stopReason: "error", errorMessage: RATE_LIMITED });
	});

	it("keeps the waits within the total", async () => {
		const produce = replies(failure(RATE_LIMITED));
		const started = Date.now();
		await settle(retrySideCall(produce, { retries: 10, maxWaitMs: 4_000 }, new AbortController().signal));
		expect(Date.now() - started).toBeLessThanOrEqual(4_000);
		expect(produce.mock.calls.length).toBeGreaterThan(1);
	});

	it("does not retry a refused request or a usage limit, nor anything without a budget", async () => {
		for (const text of ["400 invalid_request_error: Invalid request", "429 insufficient_quota"]) {
			const produce = replies(failure(text));
			await settle(retrySideCall(produce, INTERACTIVE_RETRY, new AbortController().signal));
			expect(produce, text).toHaveBeenCalledTimes(1);
		}
		const produce = replies(failure(RATE_LIMITED));
		await settle(retrySideCall(produce, undefined, new AbortController().signal));
		expect(produce).toHaveBeenCalledTimes(1);
	});

	it("ends a wait when the caller aborts, keeping the failure that started it", async () => {
		const produce = replies(failure(RATE_LIMITED), fauxAssistantMessage("ok"));
		const controller = new AbortController();
		const pending = retrySideCall(produce, INTERACTIVE_RETRY, controller.signal);
		await vi.advanceTimersByTimeAsync(10);
		controller.abort();
		const reply = await settle(pending);
		expect(produce).toHaveBeenCalledTimes(1);
		expect(reply).toMatchObject({ stopReason: "error", errorMessage: RATE_LIMITED });
	});
});
