import { describe, expect, it, vi } from "vitest";
import { heartbeatDue, insideDeclaredWork } from "../../src/octocode/subagents/liveness.ts";
import { STALL_MS } from "../../src/octocode/team/member-list.ts";
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

describe("the watchdog's heartbeat for the row's last progress", () => {
	it("calls the beat on each tick, and tells it when the machine just woke", () => {
		const beat = vi.fn();
		const child = { toolsRunning: 0, settling: false, busyUntil: 0, lastActivity: "→ bash make" };
		const dog = new ChildWatchdog(child, LIMITS, () => false, vi.fn(), beat);
		const start = dog.activeAt;
		dog.tick(start + INTERVAL);
		expect(beat).toHaveBeenLastCalledWith(start + INTERVAL, false);
		dog.tick(start + 30 * 60_000);
		expect(beat).toHaveBeenLastCalledWith(start + 30 * 60_000, true);
	});
});

describe("work that may stay quiet without being stalled", () => {
	const base = { running: true, toolsRunning: 0, declaredUntil: 0, jobsUntil: 0 };

	it("counts a running call with its own timeout, or a pending job with one, and nothing else", () => {
		expect(insideDeclaredWork({ ...base, toolsRunning: 1, declaredUntil: 5_000 }, 1_000)).toBe(true);
		expect(insideDeclaredWork({ ...base, toolsRunning: 1, declaredUntil: 5_000 }, 6_000)).toBe(false);
		// A declared deadline of a call that ended is no cover for the next one.
		expect(insideDeclaredWork({ ...base, toolsRunning: 0, declaredUntil: 5_000 }, 1_000)).toBe(false);
		expect(insideDeclaredWork({ ...base, jobsUntil: 5_000 }, 1_000)).toBe(true);
		expect(insideDeclaredWork(base, 1_000)).toBe(false);
	});

	it("stamps progress only for a running child that works in declared work or waits for the user", () => {
		expect(heartbeatDue({ ...base, jobsUntil: 5_000 }, 1_000, false)).toBe(true);
		expect(heartbeatDue(base, 1_000, true)).toBe(true);
		expect(heartbeatDue(base, 1_000, false)).toBe(false);
		expect(heartbeatDue({ ...base, running: false, jobsUntil: 5_000 }, 1_000, true)).toBe(false);
		expect(STALL_MS).toBe(10 * 60_000);
	});
});
