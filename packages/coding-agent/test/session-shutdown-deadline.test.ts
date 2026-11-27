import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchEvent } from "../src/core/features/runner/emit-events.ts";
import { SHUTDOWN_HANDLER_TIMEOUT_MS } from "../src/core/features/runner/shutdown-deadline.ts";
import type { RunnerHost } from "../src/core/features/runner/types.ts";
import type { FeatureError } from "../src/core/features/types.ts";

type Handler = () => Promise<unknown>;

function host(buckets: Array<{ path: string; handlers: Handler[] }>, errors: FeatureError[]): RunnerHost {
	return {
		createContext: () => ({}),
		bus: {
			snapshot: () => buckets.map(({ path, handlers }) => ({ feature: { path, owner: "native" }, handlers })),
		},
		emitError: (error: FeatureError) => errors.push(error),
	} as unknown as RunnerHost;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("session_shutdown dispatch", () => {
	it("runs the features after a hanging handler once its deadline passes, and reports it", async () => {
		vi.useFakeTimers();
		const errors: FeatureError[] = [];
		const ran: string[] = [];
		const dispatched = dispatchEvent(
			host(
				[
					{ path: "hangs", handlers: [() => new Promise(() => {})] },
					{ path: "later", handlers: [async () => void ran.push("later")] },
				],
				errors,
			),
			{ type: "session_shutdown", reason: "quit" } as never,
		);
		await vi.advanceTimersByTimeAsync(SHUTDOWN_HANDLER_TIMEOUT_MS - 1);
		expect(ran).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		await dispatched;
		expect(ran).toEqual(["later"]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ source: "hangs", event: "session_shutdown" });
	});

	it("reports a late handler's failure after the deadline", async () => {
		vi.useFakeTimers();
		const errors: FeatureError[] = [];
		let fail: (error: Error) => void = () => {};
		const late = new Promise((_resolve, reject) => {
			fail = reject;
		});
		const dispatched = dispatchEvent(host([{ path: "slow", handlers: [() => late] }], errors), {
			type: "session_shutdown",
			reason: "quit",
		} as never);
		await vi.advanceTimersByTimeAsync(SHUTDOWN_HANDLER_TIMEOUT_MS);
		await dispatched;
		fail(new Error("close failed"));
		await vi.advanceTimersByTimeAsync(0);
		expect(errors.map((error) => error.error)).toEqual([expect.stringContaining("did not finish"), "close failed"]);
	});

	it("waits for a handler that finishes in time and leaves no timer behind", async () => {
		vi.useFakeTimers();
		const errors: FeatureError[] = [];
		const dispatched = dispatchEvent(
			host([{ path: "quick", handlers: [() => new Promise((resolve) => setTimeout(resolve, 50))] }], errors),
			{ type: "session_shutdown", reason: "quit" } as never,
		);
		await vi.advanceTimersByTimeAsync(50);
		await dispatched;
		expect(errors).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
