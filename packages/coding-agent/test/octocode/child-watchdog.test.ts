import { describe, expect, it, vi } from "vitest";
import { ChildWatchdog } from "../../src/octocode/subagents/process/watchdog.ts";

const LIMITS = { idleMs: 10 * 60_000, busyMs: 15 * 60_000 };
const INTERVAL = 30_000;

function watchdog(state: { toolsRunning?: number; busyUntil?: number } = {}) {
	const child = { toolsRunning: 0, settling: false, busyUntil: 0, lastActivity: "→ bash make", ...state };
	const onStall = vi.fn();
	const dog = new ChildWatchdog(child, LIMITS, () => false, onStall);
	return { child, onStall, dog };
}

describe("the subagent watchdog and machine sleep", () => {
	it("still stops a child silent past the idle limit while the machine was awake", () => {
		const { dog, onStall } = watchdog();
		const start = dog.activeAt;
		for (let t = INTERVAL; t <= LIMITS.idleMs; t += INTERVAL) dog.tick(start + t);
		expect(onStall).toHaveBeenCalledOnce();
		expect(dog.stalled?.message).toMatch(/no output for 10m/);
	});

	it("does not stop a silent child when the clock jumps past a suspend", () => {
		const { dog, onStall } = watchdog();
		const start = dog.activeAt;
		// Half an hour with the lid closed, then the next tick: the idle limit is not spent.
		dog.tick(start + 30 * 60_000);
		dog.tick(start + 30 * 60_000 + INTERVAL);
		expect(onStall).not.toHaveBeenCalled();
		// The limit counts again from the wake.
		dog.tick(start + 30 * 60_000 + LIMITS.idleMs + INTERVAL);
		expect(onStall).not.toHaveBeenCalled();
	});

	it("does not stop a child in a tool past its deadline when the clock jumps past a suspend", () => {
		const start = Date.now();
		const { dog, child, onStall } = watchdog({ toolsRunning: 1, busyUntil: start + 60_000 });
		const before = child.busyUntil;
		dog.tick(start + 60 * 60_000);
		expect(onStall).not.toHaveBeenCalled();
		expect(child.busyUntil).toBeGreaterThanOrEqual(before + 59 * 60_000);
		// The deadline still holds once awake: the minute the call had left runs out.
		dog.tick(start + 60 * 60_000 + INTERVAL);
		expect(onStall).not.toHaveBeenCalled();
		dog.tick(start + 60 * 60_000 + 2 * INTERVAL);
		dog.tick(start + 60 * 60_000 + 3 * INTERVAL);
		expect(onStall).toHaveBeenCalledOnce();
		expect(dog.stalled?.message).toMatch(/ran past its own deadline/);
	});

	it("does not count a late tick within its margin as a suspend", () => {
		const { dog, onStall } = watchdog();
		const start = dog.activeAt;
		// Each tick 10 s late, as under load: the silence still counts, and the child stops at its limit.
		for (let t = INTERVAL + 10_000; t <= LIMITS.idleMs + INTERVAL; t += INTERVAL + 10_000) dog.tick(start + t);
		expect(onStall).toHaveBeenCalledOnce();
	});
});
