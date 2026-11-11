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

	it("keeps one line per event in auto mode when the terminal already accelerates", () => {
		const accelerator = new WheelScrollAccelerator("auto", false);
		assert.deepStrictEqual(scroll(accelerator, [0, 10, 20, 30]), [1, 1, 1, 1]);
		// Any number of events at an ordinary pace stays one line each.
		const steady = Array.from({ length: 60 }, (_, index) => 1000 + index * 12);
		assert.ok(scroll(accelerator, steady).every((lines) => lines === 1));
	});

	it("moves more lines per event only inside a long dense run on such a terminal, and stops when it ends", () => {
		const accelerator = new WheelScrollAccelerator("auto", false);
		const flick = Array.from({ length: 30 }, (_, index) => index * 4);
		const lines = scroll(accelerator, flick);
		assert.deepStrictEqual(lines.slice(0, 8), [1, 1, 1, 1, 1, 1, 1, 1]);
		assert.strictEqual(lines[8], 2);
		assert.strictEqual(lines[23], 2);
		assert.strictEqual(lines[24], 3);
		// A slower event, or the other direction, ends the run.
		assert.strictEqual(accelerator.next(1, 30 * 4 + 20), 1);
		assert.deepStrictEqual(scroll(accelerator, [200, 204, 208]), [1, 1, 1]);
		assert.strictEqual(accelerator.next(-1, 212), 1);
		// A fixed line count is never changed.
		const fixed = new WheelScrollAccelerator(1, false);
		assert.ok(scroll(fixed, flick).every((count) => count === 1));
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
