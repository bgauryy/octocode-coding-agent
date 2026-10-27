import { afterEach, describe, expect, it, vi } from "vitest";
import { StartGate } from "../../src/octocode/subagents/rate-gate.ts";

describe("subagent start gate", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function gateAt(clock: { now: number }) {
		return new StartGate(() => clock.now);
	}

	it("ignores failures that are not rate limits", () => {
		const clock = { now: 1_000_000 };
		const gate = gateAt(clock);
		gate.noteFailure(undefined);
		gate.noteFailure("Connection refused");
		gate.noteFailure("401 unauthorized");
		expect(gate.remainingMs()).toBe(0);
	});

	it("pauses starts after a rate limit and doubles the pause up to a cap", () => {
		const clock = { now: 1_000_000 };
		const gate = gateAt(clock);
		gate.noteFailure("429 rate_limit_error");
		expect(gate.remainingMs()).toBe(5_000);
		clock.now += 1_000;
		gate.noteFailure("429 rate_limit_error");
		expect(gate.remainingMs()).toBe(10_000);
		for (let i = 0; i < 5; i++) gate.noteFailure("Too many requests");
		expect(gate.remainingMs()).toBe(30_000);
		clock.now += 30_000;
		expect(gate.remainingMs()).toBe(0);
	});

	it("starts the backoff over after a quiet minute", () => {
		const clock = { now: 1_000_000 };
		const gate = gateAt(clock);
		gate.noteFailure("429");
		gate.noteFailure("429");
		clock.now += 10_000 + 60_001;
		gate.noteFailure("429");
		expect(gate.remainingMs()).toBe(5_000);
	});

	it("waits out the pause and gives up when the signal aborts", async () => {
		vi.useFakeTimers();
		const gate = new StartGate();
		gate.noteFailure("429 rate limit");
		let done = false;
		const waiting = gate.wait().then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(4_999);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await waiting;
		expect(done).toBe(true);

		gate.noteFailure("429 rate limit");
		const controller = new AbortController();
		const aborted = gate.wait(controller.signal);
		const assertion = expect(aborted).rejects.toThrow(/Cancelled/);
		controller.abort();
		await assertion;
	});

	it("does not wait when no pause is active", async () => {
		await expect(new StartGate().wait()).resolves.toBeUndefined();
	});
});
