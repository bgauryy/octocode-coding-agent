import assert from "node:assert";
import { afterEach, describe, it, mock } from "node:test";
import { animationClock } from "../src/tokens/clock.ts";

function advance(ms: number, step = 20): void {
	for (let done = 0; done < ms; done += step) mock.timers.tick(step);
}

describe("animationClock focus", () => {
	afterEach(() => {
		animationClock.setFocused(true);
		animationClock.setReducedMotion(false);
		mock.timers.reset();
	});

	it("slows decoration to about 500 ms steps while unfocused, counters keep 1 s", () => {
		mock.timers.enable({ apis: ["setInterval", "Date"] });
		const decorAt: number[] = [];
		let info = 0;
		const stopDecor = animationClock.subscribe((now) => decorAt.push(now), { everyMs: 80, kind: "decor" });
		const stopInfo = animationClock.subscribe(() => info++, { everyMs: 1_000, kind: "info" });
		animationClock.setFocused(false);
		decorAt.length = 0;
		advance(2_000);
		assert.ok(decorAt.length >= 3 && decorAt.length <= 4, `decor steps: ${decorAt.length}`);
		for (let i = 1; i < decorAt.length; i++) assert.strictEqual(decorAt[i] - decorAt[i - 1], 500);
		assert.strictEqual(info, 2);
		stopDecor();
		stopInfo();
	});

	it("keeps a decor subscriber slower than the unfocused step at its own rate", () => {
		mock.timers.enable({ apis: ["setInterval", "Date"] });
		let slow = 0;
		const stop = animationClock.subscribe(() => slow++, { everyMs: 1_000, kind: "decor" });
		animationClock.setFocused(false);
		advance(3_000);
		assert.strictEqual(slow, 3);
		assert.strictEqual(animationClock.isRunning(), true);
		stop();
	});

	it("draws decoration from real time while unfocused", () => {
		mock.timers.enable({ apis: ["setInterval", "Date"], now: 10_000 });
		animationClock.setFocused(false);
		advance(3_000);
		assert.strictEqual(animationClock.decorationTime(), 13_000);
		animationClock.setFocused(true);
		assert.strictEqual(animationClock.decorationTime(), 13_000);
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
		assert.ok(decor <= 11, `no catch-up burst: ${decor}`);
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
