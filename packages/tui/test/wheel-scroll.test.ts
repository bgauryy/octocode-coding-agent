import assert from "node:assert";
import { describe, it } from "node:test";
import { WheelScrollAccelerator } from "../src/wheel-scroll.ts";

function scroll(accelerator: WheelScrollAccelerator, times: number[], direction: -1 | 1 = 1): number[] {
	return times.map((time) => accelerator.next(direction, time));
}

// #9758: fullscreen wheel scrolling was one line per notch on terminals that do not accelerate wheels.
describe("WheelScrollAccelerator", () => {
	it("uses fixed line counts regardless of timing", () => {
		const accelerator = new WheelScrollAccelerator(3, true);
		assert.deepStrictEqual(scroll(accelerator, [0, 10, 20, 1000]), [3, 3, 3, 3]);
		accelerator.setLines(0.5);
		assert.strictEqual(accelerator.next(1, 2000), 1);
	});

	it("keeps slow and medium scrolling at one line per event when the terminal already accelerates", () => {
		const accelerator = new WheelScrollAccelerator("auto", false);
		const slow = Array.from({ length: 20 }, (_, index) => index * 100);
		assert.ok(scroll(accelerator, slow).every((lines) => lines === 1));
		// 40 events a second (25 ms apart) is deliberate scrolling, not a flick.
		const medium = Array.from({ length: 80 }, (_, index) => 5000 + index * 25);
		assert.ok(scroll(accelerator, medium).every((lines) => lines === 1));
	});

	it("keeps up with a 120 events/s flick on such a terminal (Terminal.app's measured rate)", () => {
		const accelerator = new WheelScrollAccelerator("auto", false);
		const flick = Array.from({ length: 240 }, (_, index) => index * 8.33);
		const lines = scroll(accelerator, flick);
		// The first events stay one line, so a short flick still lands precisely.
		assert.deepStrictEqual(lines.slice(0, 3), [1, 1, 1]);
		const total = lines.reduce((sum, count) => sum + count, 0);
		// One line per event moved 239 rows; the flick now moves several times that, rising as it lasts.
		assert.ok(total >= 1200 && total <= 1500, `240 events moved ${total} rows`);
		assert.ok(lines[10] >= 3 && lines[10] <= 4, `early lines ${lines[10]}`);
		assert.ok(lines[200] >= 6 && lines[200] <= 8, `sustained lines ${lines[200]}`);
		assert.ok(lines.every((count) => count <= 8));
	});

	it("scales a flick with its velocity: one event per frame moves fewer lines than 120 per second", () => {
		const perFrame = scroll(
			new WheelScrollAccelerator("auto", false),
			Array.from({ length: 120 }, (_, index) => index * 16.7),
		);
		const fast = scroll(
			new WheelScrollAccelerator("auto", false),
			Array.from({ length: 120 }, (_, index) => index * 8.33),
		);
		const sum = (values: number[]) => values.reduce((total, count) => total + count, 0);
		assert.ok(sum(perFrame) > 120, "a sustained 60 events/s run still accelerates");
		assert.ok(sum(fast) > sum(perFrame) * 1.6, `${sum(fast)} vs ${sum(perFrame)}`);
	});

	it("ends a flick on a pause or a direction change", () => {
		const accelerator = new WheelScrollAccelerator("auto", false);
		const flick = Array.from({ length: 30 }, (_, index) => index * 8);
		assert.ok(scroll(accelerator, flick).at(-1)! > 1);
		// A slower event ends the run: it and the next ramp events move one line.
		assert.strictEqual(accelerator.next(1, 29 * 8 + 40), 1);
		assert.deepStrictEqual(scroll(accelerator, [400, 408, 416]), [1, 1, 1]);
		// Alternating directions never build a run, however fast.
		const mixed = Array.from({ length: 40 }, (_, index) =>
			accelerator.next(index % 2 === 0 ? -1 : 1, 1000 + index * 8),
		);
		assert.ok(mixed.every((lines) => lines === 1));
		// A fixed line count is never changed.
		const fixed = new WheelScrollAccelerator(1, false);
		assert.ok(scroll(fixed, flick).every((count) => count === 1));
		const three = new WheelScrollAccelerator(3, false);
		assert.ok(scroll(three, flick).every((count) => count === 3));
	});

	it("scales auto mode with wheel velocity", () => {
		const accelerator = new WheelScrollAccelerator("auto", true);
		assert.deepStrictEqual(scroll(accelerator, [0, 150, 300, 450]), [1, 1, 1, 1]);
		assert.deepStrictEqual(scroll(accelerator, [1000, 1050, 1100, 1150]), [1, 2, 2, 2]);
		assert.deepStrictEqual(scroll(accelerator, [2000, 2020, 2040, 2060]), [1, 5, 5, 5]);
		assert.deepStrictEqual(scroll(accelerator, [3000, 3010, 3020, 3030]), [1, 6, 6, 6]);
	});

	it("does not accelerate bursts of events for a single notch", () => {
		const accelerator = new WheelScrollAccelerator("auto", true);
		assert.deepStrictEqual(scroll(accelerator, [0, 3, 6, 9]), [1, 1, 1, 1]);
	});

	it("resets acceleration on direction changes and pauses", () => {
		const accelerator = new WheelScrollAccelerator("auto", true);
		assert.deepStrictEqual(scroll(accelerator, [0, 20, 40]), [1, 5, 5]);
		assert.strictEqual(accelerator.next(-1, 60), 1);
		assert.deepStrictEqual(scroll(accelerator, [500, 520]), [1, 5]);
	});

	it("carries fractional lines between events", () => {
		const accelerator = new WheelScrollAccelerator("auto", true);
		assert.deepStrictEqual(scroll(accelerator, [0, 40, 80, 120, 160]), [1, 2, 3, 2, 3]);
	});
});
