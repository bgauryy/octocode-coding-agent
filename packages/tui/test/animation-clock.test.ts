import assert from "node:assert";
import { afterEach, describe, it, mock } from "node:test";
import { animationClock } from "../src/tokens/clock.ts";
import { breathe, GLYPH, MOTION, SPINNER, settle } from "../src/tokens/design.ts";

/** Advance mocked time frame by frame, as a real event loop would. */
function advance(ms: number, step = 20): void {
	for (let done = 0; done < ms; done += step) mock.timers.tick(step);
}

describe("animationClock", () => {
	it("spaces a decor subscriber whose interval is no multiple of the cadence evenly", () => {
		let wall = 1_000_000;
		mock.timers.enable({ apis: ["setInterval"] });
		const wallClock = mock.method(Date, "now", () => wall);
		const fires: number[] = [];
		const stopFast = animationClock.subscribe(() => {}, { everyMs: 80, kind: "decor" });
		const stopSlow = animationClock.subscribe((now) => fires.push(now), { everyMs: 200, kind: "decor" });
		try {
			for (let done = 0; done < 3000; done += 20) {
				wall += 20;
				mock.timers.tick(20);
			}
			const gaps = fires.slice(1).map((at, index) => at - fires[index]);
			assert.ok(gaps.length >= 8);
			assert.strictEqual(new Set(gaps).size, 1, `gaps ${gaps.join(",")}`);
		} finally {
			stopSlow();
			stopFast();
			wallClock.mock.restore();
		}
	});

	it("resumes ticking within one interval after the wall clock steps back", () => {
		// The interval timer is monotonic; only Date.now() steps back.
		let wall = 1_000_000;
		mock.timers.enable({ apis: ["setInterval"] });
		const wallClock = mock.method(Date, "now", () => wall);
		const tickFor = (ms: number) => {
			for (let done = 0; done < ms; done += 20) {
				wall += 20;
				mock.timers.tick(20);
			}
		};
		let calls = 0;
		const stop = animationClock.subscribe(() => calls++, { everyMs: 1000, kind: "info" });
		try {
			tickFor(2000);
			const before = calls;
			assert.ok(before >= 1);
			wall -= 60_000;
			tickFor(1100);
			assert.ok(calls > before, "a tick lands within one interval of the step");
		} finally {
			stop();
			wallClock.mock.restore();
		}
	});

	it("advances the frame time once per tick whatever the timer jitter", () => {
		let wall = 1_000_000;
		mock.timers.enable({ apis: ["setInterval"] });
		const wallClock = mock.method(Date, "now", () => wall);
		const frames: number[] = [];
		const stop = animationClock.subscribe(() => frames.push(Math.floor(animationClock.frameTime() / 80)), {
			everyMs: 80,
			kind: "decor",
		});
		try {
			// Ticks land a millisecond either side of their slot, and the slots sit on the frame boundaries.
			const jitter = [0, 1, -1, 1, -1, 0, -1, 1, 1, -1];
			let slot = wall;
			for (let tick = 0; tick < 200; tick++) {
				slot += 80;
				wall = slot + jitter[tick % jitter.length];
				mock.timers.tick(80);
			}
			assert.ok(frames.length >= 190);
			const steps = frames.slice(1).map((frame, index) => frame - frames[index]);
			assert.ok(
				steps.every((step) => step === 1),
				`frame steps: ${[...new Set(steps)]}`,
			);
		} finally {
			stop();
			wallClock.mock.restore();
		}
	});

	it("notifies motion-mode changes from a stable subscription snapshot", () => {
		let calls = 0;
		let stop: (() => void) | undefined;
		const listen = () => {
			calls++;
			stop?.();
			stop = animationClock.subscribe(listen, { everyMs: 80, kind: "decor" });
			// Bound the pre-fix live-Set traversal so this regression fails instead of hanging the process.
			if (calls >= 3) stop();
		};
		stop = animationClock.subscribe(listen, { everyMs: 80, kind: "decor" });
		try {
			animationClock.setReducedMotion(true);
			assert.strictEqual(calls, 1, "a replacement subscription starts on the next notification");
		} finally {
			stop();
		}
	});

	it("isolates a failed motion-mode repaint and still notifies the other animations", () => {
		const reported: unknown[] = [];
		const reject = mock.method(Promise, "reject", (error: unknown) => {
			reported.push(error);
			return Promise.resolve();
		});
		let healthy = 0;
		const stopFailing = animationClock.subscribe(
			() => {
				throw new Error("disposed repaint");
			},
			{ everyMs: 80, kind: "decor" },
		);
		const stopHealthy = animationClock.subscribe(() => healthy++, { everyMs: 80, kind: "decor" });
		try {
			assert.doesNotThrow(() => animationClock.setReducedMotion(true));
			assert.strictEqual(healthy, 1);
			assert.deepStrictEqual(
				reported.map((error) => (error as Error).message),
				["disposed repaint"],
			);
			animationClock.setReducedMotion(false);
			assert.strictEqual(healthy, 2);
			assert.strictEqual(reported.length, 1, "failed subscriber was released");
		} finally {
			stopFailing();
			stopHealthy();
			reject.mock.restore();
		}
	});

	afterEach(() => {
		animationClock.setReducedMotion(false);
		mock.timers.reset();
	});

	it("runs only while someone subscribes, at the fastest cadence, and calls each at its own", () => {
		mock.timers.enable({ apis: ["setInterval", "Date"] });
		assert.strictEqual(animationClock.isRunning(), false);
		let fast = 0;
		let slow = 0;
		const stopFast = animationClock.subscribe(() => fast++, { everyMs: 80, kind: "decor" });
		const stopSlow = animationClock.subscribe(() => slow++, { everyMs: 1_000, kind: "info" });
		assert.strictEqual(animationClock.isRunning(), true);
		advance(1_040);
		assert.strictEqual(fast, 13);
		assert.strictEqual(slow, 1);
		stopFast();
		stopSlow();
		assert.strictEqual(animationClock.isRunning(), false);
	});

	it("drops a subscriber that throws and reports it as a rejection; the others keep running", () => {
		mock.timers.enable({ apis: ["setInterval", "Date"] });
		const reported: unknown[] = [];
		const reject = mock.method(Promise, "reject", (error: unknown) => {
			reported.push(error);
			return Promise.resolve();
		});
		let failing = 0;
		let healthy = 0;
		const stopFailing = animationClock.subscribe(
			() => {
				failing++;
				throw new Error("disposed component");
			},
			{ everyMs: 80, kind: "decor" },
		);
		const stopHealthy = animationClock.subscribe(() => healthy++, { everyMs: 80, kind: "decor" });
		advance(400);
		reject.mock.restore();
		assert.strictEqual(failing, 1);
		assert.ok(healthy >= 4);
		assert.deepStrictEqual(
			reported.map((error) => (error as Error).message),
			["disposed component"],
		);
		stopFailing();
		stopHealthy();
		assert.strictEqual(animationClock.isRunning(), false);
	});

	it("keeps a slow counter on time beside a fast spinner", () => {
		mock.timers.enable({ apis: ["setInterval", "Date"] });
		let seconds = 0;
		const stopSpin = animationClock.subscribe(() => {}, { everyMs: 80, kind: "decor" });
		const stopCount = animationClock.subscribe(() => seconds++, { everyMs: 1_000, kind: "info" });
		// Never early: the first spinner tick at or after 1 s is 1040 ms.
		advance(1_020);
		assert.strictEqual(seconds, 0);
		advance(20);
		assert.strictEqual(seconds, 1);
		// No drift: ten calls in ten seconds (counting from the last due time, not the late tick).
		advance(8_960);
		assert.strictEqual(seconds, 10);
		stopSpin();
		stopCount();
	});

	it("holds decoration still while the user scrolls, keeps counters, and resumes after the hold", () => {
		mock.timers.enable({ apis: ["setInterval", "Date"] });
		let spinner = 0;
		let counter = 0;
		const stopSpinner = animationClock.subscribe(() => spinner++, { everyMs: 80, kind: "decor" });
		const stopCounter = animationClock.subscribe(() => counter++, { everyMs: 1_000, kind: "info" });
		advance(400);
		assert.strictEqual(spinner, 5);
		const frozenAt = animationClock.decorationTime();
		// A wheel event every 200 ms for 2 s, each holding decoration 300 ms.
		for (let wheel = 0; wheel < 10; wheel++) {
			animationClock.holdDecoration(300);
			advance(200);
		}
		assert.strictEqual(spinner, 5, "the spinner did not repaint while scrolling");
		assert.strictEqual(animationClock.decorationTime(), frozenAt, "time-drawn decoration shows where it stopped");
		assert.strictEqual(counter, 2, "the elapsed-seconds counter kept its tick");
		advance(400);
		assert.ok(spinner > 5, "the spinner resumes after the hold");
		assert.ok(animationClock.decorationTime() > frozenAt);
		stopSpinner();
		stopCounter();
	});

	it("freezes decoration in reduced motion but keeps counters, repainting decor once on each switch", () => {
		mock.timers.enable({ apis: ["setInterval", "Date"] });
		let decor = 0;
		let info = 0;
		const stopDecor = animationClock.subscribe(() => decor++, { everyMs: 80, kind: "decor" });
		const stopInfo = animationClock.subscribe(() => info++, { everyMs: 1_000, kind: "info" });
		animationClock.setReducedMotion(true);
		assert.strictEqual(decor, 1);
		advance(2_000);
		assert.strictEqual(decor, 1);
		assert.strictEqual(info, 2);
		stopInfo();
		// Only a frozen subscriber is left: nothing ticks.
		assert.strictEqual(animationClock.isRunning(), false);
		animationClock.setReducedMotion(false);
		assert.strictEqual(decor, 2);
		assert.strictEqual(animationClock.isRunning(), true);
		stopDecor();
	});
});

describe("design tokens", () => {
	it("gives each state one distinct mark, the running one being the spinner's first frame", () => {
		const states = [GLYPH.pending, GLYPH.running, GLYPH.waiting, GLYPH.done, GLYPH.failed, GLYPH.stopped];
		assert.strictEqual(new Set(states).size, states.length);
		assert.strictEqual(GLYPH.running, SPINNER.braille[0]);
		assert.ok(!(states as string[]).includes(GLYPH.live));
	});

	it("breathes 0 → 1 → 0 over a period and settles 1 → 0 after a flash", () => {
		assert.strictEqual(breathe(0, 1_000), 0);
		assert.strictEqual(breathe(500, 1_000), 1);
		assert.ok(breathe(999, 1_000) < 0.01);
		assert.strictEqual(settle(100, 100), 1);
		assert.ok(settle(100 + MOTION.flashMs / 2, 100) > 0 && settle(100 + MOTION.flashMs / 2, 100) < 0.5);
		assert.strictEqual(settle(100 + MOTION.flashMs, 100), 0);
	});
});
