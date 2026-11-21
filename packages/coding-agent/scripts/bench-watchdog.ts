/**
 * Subagent watchdog cost at 1/6/20 owned synthetic children (B115): timers, CPU per tick, event-loop delay, deadline
 * accuracy, suspend/resume, paused prompts and stop cleanup. No real child, session or signal is involved.
 *   node packages/coding-agent/scripts/bench-watchdog.ts
 * Production limits are idleMs 10 min, so the interval is 30 s; the worst case (idleMs <= 1 s) is 250 ms and is run too.
 */
import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { ChildWatchdog } from "../src/octocode/subagents/process/watchdog.ts";
import type { ChildState } from "../src/octocode/subagents/events.ts";

type State = Pick<ChildState, "toolsRunning" | "settling" | "busyUntil" | "lastActivity">;
const state = (): State => ({ toolsRunning: 0, settling: false, busyUntil: 0, lastActivity: "bench" });
const cpuMs = () => {
	const u = process.cpuUsage();
	return (u.user + u.system) / 1000;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const out: Record<string, unknown>[] = [];

// 1. Pure tick cost: the callback itself, many calls, for the busy and the idle branch.
for (const busy of [false, true]) {
	const s = state();
	s.toolsRunning = busy ? 1 : 0;
	s.busyUntil = Number.MAX_SAFE_INTEGER;
	let beats = 0;
	const dog = new ChildWatchdog(
		s,
		{ idleMs: 600_000, busyMs: 900_000 },
		() => false,
		() => {},
		() => void beats++,
	);
	const n = 200_000;
	const c0 = cpuMs();
	for (let i = 0, now = Date.now(); i < n; i++) dog.tick(now + i);
	out.push({ bench: "tick", busy, calls: n, cpuUsPerTick: +(((cpuMs() - c0) * 1000) / n).toFixed(3), beats });
}

// 2. Real timers at 1/6/20 children, production and worst-case cadence.
for (const idleMs of [600_000, 1_000]) {
	for (const children of [1, 6, 20]) {
		const delay = monitorEventLoopDelay({ resolution: 5 });
		let ticks = 0;
		const dogs = Array.from({ length: children }, () => {
			const dog = new ChildWatchdog(
				state(),
				{ idleMs, busyMs: idleMs },
				() => false,
				() => {},
				() => void ticks++,
			);
			dog.start();
			return dog;
		});
		delay.enable();
		const c0 = cpuMs();
		const window = idleMs === 1_000 ? 2_000 : 1_500;
		await sleep(window);
		const cpu = cpuMs() - c0;
		delay.disable();
		for (const dog of dogs) dog.stop();
		out.push({
			bench: "timers",
			idleMs,
			children,
			timersOwned: children, // one unref'd interval per child (start()); unref'd timers are invisible to getActiveResourcesInfo
			ticksInWindow: ticks,
			windowMs: window,
			cpuMs: +cpu.toFixed(2),
			loopDelayP99Ms: +(delay.percentile(99) / 1e6).toFixed(2),
		});
	}
}

// 3. Deadline accuracy: how long after the idle deadline the stall fires (bounded by the interval).
for (const children of [1, 6, 20]) {
	const idleMs = 1_000;
	const late: number[] = [];
	await Promise.all(
		Array.from({ length: children }, async () => {
			const dog = new ChildWatchdog(
				state(),
				{ idleMs, busyMs: idleMs },
				() => false,
				() => (stalledAt = Date.now()),
			);
			let stalledAt = 0;
			dog.start();
			const deadline = dog.activeAt + idleMs;
			while (!dog.stalled) await sleep(20);
			dog.stop();
			late.push(stalledAt - deadline);
		}),
	);
	out.push({
		bench: "deadline",
		children,
		idleMs,
		intervalMs: 250,
		lateMs: { min: Math.min(...late), max: Math.max(...late) },
	});
}

// 4. Suspend/resume, paused prompts, hold, stop.
{
	const s = state();
	let stalls = 0;
	let resumed = 0;
	const paused = true;
	const limits = { idleMs: 1_000, busyMs: 1_000 };
	const dog = new ChildWatchdog(
		s,
		limits,
		() => paused,
		() => void stalls++,
		(_n, r) => r && resumed++,
	);
	const base = dog.activeAt;
	dog.tick(base + 250);
	dog.tick(base + 5_000); // paused prompt: silence past idleMs must not stall
	const pausedStall = stalls;
	const slept = new ChildWatchdog(
		state(),
		limits,
		() => false,
		() => void stalls++,
		(_n, r) => r && resumed++,
	);
	const start = slept.activeAt;
	slept.tick(start + 250);
	slept.tick(start + 100_000); // far beyond cadence + margin: the machine slept, deadlines move by the gap
	const afterSuspend = { stalls, resumed };
	slept.tick(start + 100_500);
	const stillAlive = stalls === 0;
	slept.tick(start + 105_000);
	out.push({ bench: "policy", pausedStall, afterSuspend, stillAlive, stalledAfterRealSilence: stalls === 1 });
}

for (const line of out) console.log(JSON.stringify({ ...line, load1: os.loadavg()[0].toFixed(1) }));
