import assert from "node:assert";
import { afterEach, describe, it, mock } from "node:test";
import { animationClock } from "../src/tokens/clock.ts";
import { MOTION } from "../src/tokens/design.ts";

function advance(ms: number, step = 20): void {
	for (let done = 0; done < ms; done += step) mock.timers.tick(step);
}

describe("animationClock focus", () => {
	afterEach(() => {
		animationClock.setFocused(true);
		animationClock.setReducedMotion(false);
		mock.timers.reset();
	});

	it("slows decoration to the background spinner cadence while unfocused, counters keep 1 s", () => {
		mock.timers.enable({ apis: ["setInterval", "Date"] });
		let decor = 0;
		let info = 0;
		const stopDecor = animationClock.subscribe(() => decor++, { everyMs: 80, kind: "decor" });
		const stopInfo = animationClock.subscribe(() => info++, { everyMs: 1_000, kind: "info" });
		animationClock.setFocused(false);
		decor = 0;
		advance(2_000);
		assert.ok(decor <= 2_000 / MOTION.backgroundSpinnerMs, `decor ticked ${decor} times`);
		assert.ok(decor >= 8, `decor must not freeze: ${decor}`);
		assert.strictEqual(info, 2);
		stopDecor();
		stopInfo();
	});

	it("keeps a decor subscriber that is already slower at its own cadence", () => {
		mock.timers.enable({ apis: ["setInterval", "Date"] });
		let slow = 0;
		const stop = animationClock.subscribe(() => slow++, { everyMs: 500, kind: "decor" });
		animationClock.setFocused(false);
		advance(2_000);
		assert.ok(slow >= 3 && slow <= 4, `ticked ${slow}`);
		stop();
	});

	it("restores the cadence and repaints decor once on focus in", () => {
		mock.timers.enable({ apis: ["setInterval", "Date"] });
		let decor = 0;
		const stop = animationClock.subscribe(() => decor++, { everyMs: 80, kind: "decor" });
		animationClock.setFocused(false);
		advance(1_000);
		decor = 0;
		animationClock.setFocused(true);
		assert.strictEqual(decor, 1, "one repaint on focus in");
		advance(800);
		assert.ok(decor >= 9, `back to the foreground cadence: ${decor}`);
		stop();
	});

	it("ignores repeated focus reports", () => {
		mock.timers.enable({ apis: ["setInterval", "Date"] });
		let decor = 0;
		const stop = animationClock.subscribe(() => decor++, { everyMs: 80, kind: "decor" });
		animationClock.setFocused(true);
		assert.strictEqual(decor, 0);
		stop();
	});

	it("reduced motion still wins, focused or not", () => {
		mock.timers.enable({ apis: ["setInterval", "Date"] });
		let decor = 0;
		const stop = animationClock.subscribe(() => decor++, { everyMs: 80, kind: "decor" });
		animationClock.setReducedMotion(true);
		decor = 0;
		animationClock.setFocused(false);
		advance(1_000);
		animationClock.setFocused(true);
		advance(1_000);
		assert.strictEqual(decor, 0);
		stop();
	});
});
