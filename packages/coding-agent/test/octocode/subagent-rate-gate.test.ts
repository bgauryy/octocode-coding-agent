import { afterEach, describe, expect, it, vi } from "vitest";
import { routeProvider, StartGate } from "../../src/octocode/subagents/rate-gate.ts";
import { Slots } from "../../src/octocode/subagents/slots.ts";

/** Cool-downs by provider, ending at the given clock times. */
function cooldowns(clock: { now: number }, until: Record<string, number>) {
	return { remainingMs: (provider: string) => Math.max(0, (until[provider] ?? 0) - clock.now) };
}

describe("subagent start gate", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("reads the provider from the routed model, else from the parent's", () => {
		expect(routeProvider({ model: "anthropic/claude-haiku:high", parent: "openai/gpt" })).toBe("anthropic");
		expect(routeProvider({ parent: "openai/gpt-5" })).toBe("openai");
		expect(routeProvider({})).toBeUndefined();
	});

	it("holds a start only while its own provider cools down", () => {
		const clock = { now: 1_000 };
		const gate = new StartGate(cooldowns(clock, { anthropic: 6_000 }));
		expect(gate.holds({ model: "anthropic/claude" })()).toBe(5_000);
		expect(gate.holds({ model: "openai/gpt" })()).toBe(0);
		expect(gate.holds({})()).toBe(0);
		clock.now = 6_000;
		expect(gate.holds({ model: "anthropic/claude" })()).toBe(0);
	});

	it("waits out the cool-down and gives up when the signal aborts", async () => {
		vi.useFakeTimers();
		const until = { anthropic: Date.now() + 5_000 };
		const gate = new StartGate({
			remainingMs: (provider) => Math.max(0, (until[provider as "anthropic"] ?? 0) - Date.now()),
		});
		let done = false;
		const waiting = gate.wait({ model: "anthropic/claude" }).then(() => (done = true));
		await vi.advanceTimersByTimeAsync(4_999);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await waiting;
		await expect(gate.wait({ model: "openai/gpt" })).resolves.toBeUndefined();

		until.anthropic = Date.now() + 5_000;
		const controller = new AbortController();
		const aborted = gate.wait({ model: "anthropic/claude" }, controller.signal);
		const assertion = expect(aborted).rejects.toThrow(/Cancelled/);
		controller.abort();
		await assertion;
	});
});

describe("subagent slots under a cool-down", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("never hands a freed slot to a start whose provider cools down, and gives it one when the cool-down ends", async () => {
		vi.useFakeTimers();
		const until = Date.now() + 5_000;
		const cooling = () => Math.max(0, until - Date.now());
		const slots = new Slots(() => 1);
		await slots.take(undefined);
		const order: string[] = [];
		const held = slots.take(undefined, undefined, cooling).then(() => order.push("cooling"));
		const free = slots.take(undefined).then(() => order.push("other provider"));
		slots.give();
		await vi.advanceTimersByTimeAsync(0);
		// The first waiter's provider cools down: the slot goes to the next one.
		expect(order).toEqual(["other provider"]);
		slots.give();
		await vi.advanceTimersByTimeAsync(4_999);
		expect(order).toEqual(["other provider"]);
		await vi.advanceTimersByTimeAsync(1);
		await Promise.all([held, free]);
		expect(order).toEqual(["other provider", "cooling"]);
		expect(slots.tryTake()).toBe(false);
	});

	it("does not take a free slot while its provider cools down", async () => {
		vi.useFakeTimers();
		const until = Date.now() + 2_000;
		const cooling = () => Math.max(0, until - Date.now());
		const slots = new Slots(() => 2);
		expect(slots.tryTake(cooling)).toBe(false);
		let started = false;
		const waiting = slots.take(undefined, undefined, cooling).then(() => (started = true));
		// A start on another provider is not kept behind it.
		expect(slots.tryTake()).toBe(true);
		await vi.advanceTimersByTimeAsync(1_999);
		expect(started).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await waiting;
		expect(slots.tryTake()).toBe(false);
	});
});
