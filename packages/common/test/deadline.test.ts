import { afterEach, describe, expect, it, vi } from "vitest";
import { deadline } from "../src/deadline.ts";

afterEach(() => vi.useRealTimers());

describe("deadline", () => {
	it("aborts with a TimeoutError after its time, like AbortSignal.timeout", () => {
		vi.useFakeTimers();
		const limit = deadline(1000);
		vi.advanceTimersByTime(999);
		expect(limit.signal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(limit.signal.reason).toMatchObject({ name: "TimeoutError" });
	});

	it("follows its parent's abort and reason", () => {
		const parent = new AbortController();
		const limit = deadline(60_000, parent.signal);
		parent.abort(new Error("user stopped"));
		expect(limit.signal.reason).toMatchObject({ message: "user stopped" });
		limit.clear();
		const already = deadline(60_000, parent.signal);
		expect(already.signal.aborted).toBe(true);
		already.clear();
	});

	it("leaves no timer or parent listener behind once cleared", () => {
		vi.useFakeTimers();
		const parent = new AbortController();
		const added = vi.spyOn(parent.signal, "addEventListener");
		const removed = vi.spyOn(parent.signal, "removeEventListener");
		const limit = deadline(1000, parent.signal);
		expect(vi.getTimerCount()).toBe(1);
		limit.clear();
		expect(vi.getTimerCount()).toBe(0);
		expect(removed).toHaveBeenCalledWith("abort", added.mock.calls[0][1]);
		vi.advanceTimersByTime(5000);
		expect(limit.signal.aborted).toBe(false);
	});
});
