import assert from "node:assert";
import { describe, it } from "node:test";
import { WheelScrollAccelerator } from "../src/wheel-scroll.ts";

function scroll(accelerator: WheelScrollAccelerator, times: number[], direction: -1 | 1 = 1): number[] {
	return times.map((time) => accelerator.next(direction, time));
}

// #9758: fullscreen wheel scrolling was one line per notch on terminals that do not accelerate wheels.
// Live 2026-11-12: Terminal.app sends one event per notch while scrolling slowly, so a notch moved one line there too.
describe("WheelScrollAccelerator", () => {
	it("uses fixed line counts regardless of timing", () => {
		const accelerator = new WheelScrollAccelerator(3, true);
		assert.deepStrictEqual(scroll(accelerator, [0, 10, 20, 1000]), [3, 3, 3, 3]);
		accelerator.setLines(0.5);
		assert.strictEqual(accelerator.next(1, 2000), 1);
	});

	it("moves three lines per isolated notch on every terminal (Terminal.app sends one event per slow notch)", () => {
		for (const accelerate of [false, true]) {
			const accelerator = new WheelScrollAccelerator("auto", accelerate);
			// Live: slow scrolling arrived as single events 250 ms or more apart.
			const notches = Array.from({ length: 10 }, (_, index) => index * 250);
			assert.deepStrictEqual(scroll(accelerator, notches), Array(10).fill(3), `accelerate ${accelerate}`);
			assert.deepStrictEqual(scroll(accelerator, [5000, 6000], -1), [3, 3]);
		}
	});

	it("keeps medium scrolling at one line per event when the terminal already accelerates", () => {
		const accelerator = new WheelScrollAccelerator("auto", false);
		// 40 events a second (25 ms apart) is deliberate scrolling, not a flick: after the first event, one line each.
		const medium = Array.from({ length: 80 }, (_, index) => 5000 + index * 25);
		const lines = scroll(accelerator, medium);
		assert.strictEqual(lines[0], 3);
		assert.ok(lines.slice(1).every((count) => count === 1));
		// Between a notch and a flick the lines shrink with the gap, never below the pace of isolated notches.
		const paced = scroll(
			accelerator,
			Array.from({ length: 21 }, (_, index) => 20_000 + index * 50),
		);
		const sum = paced.slice(1).reduce((total, count) => total + count, 0);
		assert.strictEqual(sum, 30, "20 events 50 ms apart move 1.5 lines each");
	});

	it("keeps up with a 120 events/s flick on such a terminal (Terminal.app's measured rate)", () => {
		const accelerator = new WheelScrollAccelerator("auto", false);
		const flick = Array.from({ length: 240 }, (_, index) => index * 8.33);
		const lines = scroll(accelerator, flick);
		// The first event is a notch; the next ones stay one line, so a short flick still lands precisely.
		assert.deepStrictEqual(lines.slice(0, 3), [3, 1, 1]);
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
		// A slower event ends the run: it moves the lines of its gap, and the next ramp events one line.
		assert.strictEqual(accelerator.next(1, 29 * 8 + 40), 1);
		assert.deepStrictEqual(scroll(accelerator, [400, 408, 416]), [3, 1, 1]);
		// Alternating directions never build a run, however fast: a reversal moves the lines of its short gap.
		const mixed = Array.from({ length: 40 }, (_, index) =>
			accelerator.next(index % 2 === 0 ? -1 : 1, 1000 + index * 8),
		);
		assert.strictEqual(mixed[0], 3, "after a pause");
		assert.ok(mixed.slice(1).every((lines) => lines === 1));
		// A fixed line count is never changed.
		const fixed = new WheelScrollAccelerator(1, false);
		assert.ok(scroll(fixed, flick).every((count) => count === 1));
		const three = new WheelScrollAccelerator(3, false);
		assert.ok(scroll(three, flick).every((count) => count === 3));
	});

	it("scales auto mode with wheel velocity", () => {
		const accelerator = new WheelScrollAccelerator("auto", true);
		assert.deepStrictEqual(scroll(accelerator, [0, 150, 300, 450]), [3, 3, 3, 3]);
		assert.deepStrictEqual(scroll(accelerator, [1000, 1050, 1100, 1150]), [3, 6, 6, 6]);
		assert.deepStrictEqual(scroll(accelerator, [2000, 2020, 2040, 2060]), [3, 12, 12, 12]);
		assert.deepStrictEqual(scroll(accelerator, [3000, 3017, 3034, 3051]), [3, 12, 12, 12]);
	});

	it("does not accelerate bursts of events for a single notch", () => {
		const accelerator = new WheelScrollAccelerator("auto", true);
		assert.deepStrictEqual(scroll(accelerator, [0, 3, 6, 9]), [3, 1, 1, 1]);
	});

	it("resets acceleration on direction changes and pauses", () => {
		const accelerator = new WheelScrollAccelerator("auto", true);
		assert.deepStrictEqual(scroll(accelerator, [0, 20, 40]), [3, 12, 12]);
		assert.strictEqual(accelerator.next(-1, 60), 3);
		assert.deepStrictEqual(scroll(accelerator, [500, 520]), [3, 12]);
	});

	it("carries fractional lines between events", () => {
		const accelerator = new WheelScrollAccelerator("auto", true);
		// 3.75 lines per event: without the carried fraction every event would move 3.
		assert.deepStrictEqual(scroll(accelerator, [0, 80, 160, 240, 320]), [3, 3, 4, 4, 4]);
	});

	it("gives the events of one terminal read the pace of the gap before it, never a 1 ms gap", () => {
		// Four events per read, 33 ms apart: the stdin parser hands them over microseconds apart.
		const reads = Array.from({ length: 40 }, (_, index) => Math.floor(index / 4) * 33 + (index % 4) * 0.01);
		const batched = scroll(new WheelScrollAccelerator("auto", false), reads);
		// Before: the clamped 1 ms gap made the fourth event of the first read jump 8 lines.
		assert.ok(Math.max(...batched) <= 4, `lines per event ${batched.join(",")}`);
		// The same hand speed (an event every 8.25 ms) spread evenly moves about as far.
		const even = scroll(
			new WheelScrollAccelerator("auto", false),
			Array.from({ length: 40 }, (_, index) => index * 8.25),
		);
		const sum = (values: number[]) => values.reduce((total, count) => total + count, 0);
		assert.ok(sum(batched) >= sum(even) * 0.7 && sum(batched) <= sum(even), `${sum(batched)} vs ${sum(even)}`);
	});

	it("moves the events of one frame at most 24 lines together, but never caps a fixed count", () => {
		for (const accelerate of [false, true]) {
			const accelerator = new WheelScrollAccelerator("auto", accelerate);
			// A sustained flick, then a read of 30 events piled up behind a stall.
			scroll(
				accelerator,
				Array.from({ length: 100 }, (_, index) => index * 8.33),
			);
			const piled = scroll(
				accelerator,
				Array.from({ length: 30 }, (_, index) => 900 + index * 0.01),
			);
			const total = piled.reduce((sum, count) => sum + count, 0);
			assert.ok(total <= 24, `accelerate ${accelerate}: ${total} lines in one frame`);
			assert.ok(piled.at(-1) === 0, "events past the cap move nothing");
			// The next frame moves again.
			assert.ok(accelerator.next(1, 900 + 17) > 0);
		}
		const fixed = new WheelScrollAccelerator(10, false);
		assert.ok(
			scroll(
				fixed,
				Array.from({ length: 10 }, (_, index) => index * 0.01),
			).every((count) => count === 10),
		);
	});

	it("carries lines beyond the frame cap to following frames instead of dropping them", () => {
		for (const accelerate of [false, true]) {
			const accelerator = new WheelScrollAccelerator("auto", accelerate);
			const piled = scroll(
				accelerator,
				Array.from({ length: 60 }, (_, index) => 900 + index * 0.01),
			);
			const sameFrame = piled.reduce((sum, count) => sum + count, 0);
			assert.ok(sameFrame <= 24, `accelerate ${accelerate}: ${sameFrame}`);
			let moved = sameFrame;
			for (let frame = 1; frame < 20; frame++) moved += accelerator.takePending(900 + frame * 17).lines;
			// Every line the 60 events asked for arrives: 1 line each past the first notch is at least 62.
			assert.ok(moved >= 60, `accelerate ${accelerate}: ${moved} lines moved in all`);
			assert.strictEqual(accelerator.takePending(5000).lines, 0);
		}
	});

	it("moves held-back lines in the direction of the events and drops them on a reversal", () => {
		const accelerator = new WheelScrollAccelerator("auto", false);
		scroll(
			accelerator,
			Array.from({ length: 60 }, (_, index) => 900 + index * 0.01),
			-1,
		);
		assert.deepStrictEqual(
			{ direction: accelerator.takePending(920).direction, more: accelerator.takePending(940).lines > 0 },
			{ direction: -1, more: true },
		);
		accelerator.next(1, 2000);
		assert.strictEqual(accelerator.takePending(2100).lines, 0);
	});

	it("drains held-back lines on a timer that clearPending cancels", async () => {
		const accelerator = new WheelScrollAccelerator("auto", false);
		scroll(
			accelerator,
			Array.from({ length: 80 }, (_, index) => performance.now() + index * 0.01),
		);
		const drained: number[] = [];
		accelerator.drainPending((_direction, lines) => drained.push(lines));
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.ok(drained.length > 0 && drained.every((lines) => lines > 0 && lines <= 24), drained.join(","));
		scroll(
			accelerator,
			Array.from({ length: 80 }, (_, index) => performance.now() + 1000 + index * 0.01),
		);
		const before = drained.length;
		accelerator.drainPending((_direction, lines) => drained.push(lines));
		accelerator.clearPending();
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.strictEqual(drained.length, before);
	});
});
