import assert from "node:assert";
import { describe, it } from "node:test";
import { planScrollShift } from "../src/tui-alt-screen/scroll-shift.ts";

const screenOf = (first: number, height: number, pad = "   ") =>
	Array.from({ length: height }, (_, row) => `line ${first + row}${row % 2 ? pad : ""}`);

describe("planScrollShift", () => {
	it("scrolls rows in place when the view moves, comparing rows without their trailing blanks", () => {
		const previous = screenOf(0, 10);
		const screen = screenOf(3, 10, "");
		const shift = planScrollShift(screen, previous);
		assert.ok(shift);
		assert.strictEqual(shift.sequence, "\x1b[0m\x1b[1;10r\x1b[3S\x1b[r");
		assert.deepStrictEqual(shift.basis, [...previous.slice(3), "", "", ""]);
	});

	it("plans each frame the same whatever frames came before", () => {
		const frames = [screenOf(0, 10), screenOf(2, 10, ""), screenOf(5, 10), screenOf(1, 10, "  "), screenOf(9, 10)];
		const planned = frames.slice(1).map((screen, index) => planScrollShift(screen, frames[index]));
		// The same pairs again, out of order and after unrelated frames, must plan the same shifts.
		planScrollShift(screenOf(40, 10), screenOf(30, 10));
		for (const index of [3, 0, 2, 1]) {
			assert.deepStrictEqual(planScrollShift(frames[index + 1], frames[index]), planned[index], `frame ${index + 1}`);
		}
	});
});
