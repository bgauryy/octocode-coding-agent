import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Terminal } from "../src/terminal.ts";
import { RenderScheduler } from "../src/tui/render-scheduler.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `condition` holds; a loaded machine only makes this slower, never wrong. */
async function until(condition: () => boolean, what: string): Promise<void> {
	for (const start = Date.now(); !condition(); await wait(2)) {
		if (Date.now() - start > 2000) assert.fail(`timed out waiting for ${what}`);
	}
}

interface FakeTerminal {
	pendingOutputBytes: number;
	synchronizedOutput?: boolean;
	frameOutputCap?: number;
}

/** Every scheduler a test started, stopped after it even when an assertion failed, so no retry timer outlives it. */
const started: RenderScheduler[] = [];
afterEach(() => {
	for (const s of started.splice(0)) s.stop();
});

function scheduler(paintCostMs = 0) {
	const frames: number[] = [];
	const terminal: FakeTerminal = { pendingOutputBytes: 0 };
	const s = new RenderScheduler({
		terminal: () => terminal as unknown as Terminal,
		isStopped: () => false,
		paint: () => {
			const start = performance.now();
			frames.push(start);
			while (performance.now() - start < paintCostMs);
		},
	});
	s.start();
	started.push(s);
	return { s, frames, terminal };
}

/** The delays the scheduler asks timers for while `run` runs; the timers still run. */
function scheduledDelays(run: () => void): number[] {
	const original = globalThis.setTimeout;
	const delays: number[] = [];
	globalThis.setTimeout = ((handler: () => void, delay?: number) => {
		delays.push(delay ?? 0);
		return original(handler, delay);
	}) as typeof setTimeout;
	try {
		run();
	} finally {
		globalThis.setTimeout = original;
	}
	return delays;
}

const PERIOD_MS = 1000 / 60;

describe("RenderScheduler pointer frames", () => {
	it("rejects an invalid interactive refresh target", () => {
		const { s } = scheduler();
		for (const interactiveFps of [0, -1, 121, Infinity, NaN]) {
			assert.throws(() => s.setPacing({ interactiveFps }), RangeError);
		}
	});
	it("paints a pointer frame well before the streaming cadence would", async () => {
		const { s, frames } = scheduler();
		s.paintNow();
		// Inside the interactive period: the frame waits for the rest of it, not for the 40 ms cadence.
		const delays = scheduledDelays(() => s.requestInteractive());
		assert.equal(delays.length, 1);
		assert.ok(delays[0] <= PERIOD_MS, `asked for ${delays[0]} ms`);
		await until(() => frames.length === 2, "the pointer frame");
		s.stop();
	});

	it("replaces a pending streaming frame and shares one frame between events of a burst", async () => {
		const { s, frames } = scheduler();
		s.paintNow();
		s.request();
		for (let i = 0; i < 20; i++) s.requestInteractive();
		await until(() => frames.length === 2, "the pointer frame");
		// Nothing is left pending for the slower timer.
		await wait(60);
		assert.equal(frames.length, 2);
		s.stop();
	});

	it("paints at once when the last frame is old, and still honors output pressure", async () => {
		const { s, frames, terminal } = scheduler();
		s.paintNow();
		await wait(20);
		s.requestInteractive();
		await wait(3);
		assert.equal(frames.length, 2);
		terminal.pendingOutputBytes = 10 * 1024 * 1024;
		await wait(15);
		s.requestInteractive();
		await wait(30);
		assert.equal(frames.length, 2);
		terminal.pendingOutputBytes = 0;
		await until(() => frames.length === 3, "the deferred frame");
		s.stop();
	});

	it("keeps a 60 Hz default independently of synchronized output and permits an explicit 120 Hz target", async () => {
		// The delay the scheduler asks for right after a frame, read from its timer: wall-clock gaps only grow under load,
		// so an upper bound on them would measure the machine, not the pacing.
		const measure = async (synchronizedOutput: boolean | undefined, interactiveFps = 60) => {
			const { s, frames, terminal } = scheduler();
			terminal.synchronizedOutput = synchronizedOutput;
			s.setPacing({ interactiveFps });
			const delays = scheduledDelays(() => {
				s.paintNow();
				s.requestInteractive();
			});
			await until(() => frames.length === 2, "the pointer frame");
			s.stop();
			return delays[0] ?? 0;
		};
		// Terminal.app answers no DECRQM: a frame faster than its paint only shows half-written states.
		assert.ok((await measure(undefined)) >= 15, "unknown support waits a whole frame");
		assert.ok((await measure(false)) >= 15);
		assert.ok((await measure(true)) >= 15, "synchronized output does not imply a faster renderer");
		const explicit = await measure(true, 120);
		assert.ok(explicit >= 7 && explicit < 15, `explicit 120 Hz target keeps 8 ms (${explicit} ms)`);
	});

	it("counts the 60 Hz period from the start of the last frame, not the end of its paint", async () => {
		// A 6 ms frame: counted from its end, the next pointer frame came 22.7 ms after this one started (44 a second).
		const { s, frames } = scheduler(6);
		s.setPacing({ metrics: true });
		const delays = scheduledDelays(() => {
			s.paintNow();
			s.requestInteractive();
		});
		assert.equal(delays.length, 1);
		assert.ok(delays[0] <= PERIOD_MS - 6, `asked for ${delays[0].toFixed(2)} ms after a 6 ms frame`);
		await until(() => frames.length === 2, "the pointer frame");
		// The scheduler's own clock: never sooner than the period after the last frame started.
		assert.ok((s.getStats().minPointerFrameGapMs ?? 0) >= PERIOD_MS);
		s.stop();
	});

	it("waits out a timer that fires before the period ends instead of painting early", async () => {
		const { s, frames } = scheduler();
		s.setPacing({ metrics: true });
		const original = globalThis.setTimeout;
		const early: Array<() => void> = [];
		// The first timer fires at once, as a timer counted from the event loop's stale clock can.
		globalThis.setTimeout = ((handler: () => void, delay?: number) => {
			if (early.length === 0) {
				early.push(handler);
				return original(handler, 0);
			}
			return original(handler, delay);
		}) as typeof setTimeout;
		try {
			s.paintNow();
			s.requestInteractive();
		} finally {
			globalThis.setTimeout = original;
		}
		await until(() => frames.length === 2, "the pointer frame");
		const stats = s.getStats();
		assert.equal(stats.pointerFrames, 1);
		const gap = stats.minPointerFrameGapMs ?? 0;
		assert.ok(gap >= PERIOD_MS, `painted ${gap.toFixed(3)} ms after the last frame started`);
		s.stop();
	});

	it("keeps pointer frames on the interactive cadence under output pressure until the frame cap", async () => {
		const { s, frames, terminal } = scheduler();
		terminal.frameOutputCap = 512 * 1024;
		s.paintNow();
		await wait(20);
		// Past the output gate's 256 KiB high water but below the cap: a streaming frame waits, a pointer frame paints.
		terminal.pendingOutputBytes = 300 * 1024;
		s.requestInteractive();
		await wait(3);
		assert.equal(frames.length, 2, "the pointer frame painted under pressure");
		s.request();
		await wait(60);
		assert.equal(frames.length, 2, "a streaming frame still waits at the gate");
		// At the cap the terminal would drop the frame: it waits, and its retries keep the pointer period, not 40 ms.
		terminal.pendingOutputBytes = 600 * 1024;
		await wait(20);
		const delays = scheduledDelays(() => s.requestInteractive());
		await wait(30);
		assert.equal(frames.length, 2);
		assert.ok(
			delays.every((delay) => delay < 17),
			`pointer retries asked for ${delays.join(", ")} ms`,
		);
		terminal.pendingOutputBytes = 0;
		await until(() => frames.length === 3, "the deferred pointer frame");
		s.stop();
	});
});
