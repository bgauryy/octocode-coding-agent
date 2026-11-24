import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Clock } from "../src/clock.ts";

describe("Clock", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("runs no timer until someone subscribes and stops it when the last one leaves", () => {
		const clock = new Clock();
		expect(clock.isRunning()).toBe(false);
		const stopA = clock.subscribe(() => {}, { everyMs: 100 });
		const stopB = clock.subscribe(() => {}, { everyMs: 100 });
		expect(clock.isRunning()).toBe(true);
		expect(vi.getTimerCount()).toBe(1);
		stopA();
		expect(clock.isRunning()).toBe(true);
		stopB();
		stopB();
		expect(clock.isRunning()).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("serves each subscriber at its own interval from one timer at the fastest cadence", () => {
		const clock = new Clock();
		const fast = vi.fn();
		const slow = vi.fn();
		const stopFast = clock.subscribe(fast, { everyMs: 100 });
		const stopSlow = clock.subscribe(slow, { everyMs: 300 });
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(900);
		expect(fast).toHaveBeenCalledTimes(9);
		expect(slow).toHaveBeenCalledTimes(3);
		stopFast();
		vi.advanceTimersByTime(900);
		expect(fast).toHaveBeenCalledTimes(9);
		expect(slow).toHaveBeenCalledTimes(6);
		stopSlow();
	});

	it("slows to the next fastest cadence when the fastest subscriber leaves", () => {
		const clock = new Clock();
		const slow = vi.fn();
		const stopFast = clock.subscribe(() => {}, { everyMs: 50 });
		const stopSlow = clock.subscribe(slow, { everyMs: 500 });
		stopFast();
		vi.advanceTimersByTime(1000);
		expect(slow).toHaveBeenCalledTimes(2);
		stopSlow();
	});

	it("calls a late joiner at the running cadence on the next tick, not a full interval later", () => {
		const clock = new Clock();
		const stopFirst = clock.subscribe(() => {}, { everyMs: 1000 });
		vi.advanceTimersByTime(400);
		const late = vi.fn();
		const stopLate = clock.subscribe(late, { everyMs: 1000 });
		vi.advanceTimersByTime(600);
		expect(late).toHaveBeenCalledTimes(1);
		stopFirst();
		stopLate();
	});

	it("runs every listener of a tick when one throws and keeps the failing one subscribed", async () => {
		const clock = new Clock();
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		const failing = vi.fn(() => {
			throw new Error("boom");
		});
		const after = vi.fn();
		const stopFailing = clock.subscribe(failing, { everyMs: 100 });
		const stopAfter = clock.subscribe(after, { everyMs: 100 });
		try {
			vi.advanceTimersByTime(200);
			await vi.advanceTimersByTimeAsync(0);
			expect(failing).toHaveBeenCalledTimes(2);
			expect(after).toHaveBeenCalledTimes(2);
		} finally {
			stopFailing();
			stopAfter();
			process.off("unhandledRejection", onRejection);
		}
	});

	it("does not call a listener that an earlier listener of the same tick unsubscribed", () => {
		const clock = new Clock();
		const second = vi.fn();
		let stopSecond = () => {};
		const stopFirst = clock.subscribe(() => stopSecond(), { everyMs: 100 });
		stopSecond = clock.subscribe(second, { everyMs: 100 });
		vi.advanceTimersByTime(300);
		expect(second).not.toHaveBeenCalled();
		stopFirst();
		expect(clock.isRunning()).toBe(false);
	});
});
