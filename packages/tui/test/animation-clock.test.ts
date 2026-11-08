import assert from "node:assert";
import { afterEach, describe, it, mock } from "node:test";
import { animationClock } from "../src/tokens/clock.ts";
import { breathe, GLYPH, MOTION, SPINNER, settle } from "../src/tokens/design.ts";

/** Advance mocked time frame by frame, as a real event loop would. */
function advance(ms: number, step = 20): void {
	for (let done = 0; done < ms; done += step) mock.timers.tick(step);
}

describe("animationClock", () => {
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
