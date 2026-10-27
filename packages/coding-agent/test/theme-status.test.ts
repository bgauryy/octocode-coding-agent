import { animationClock, GLYPH, MOTION, rgbColor, SPINNER } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it } from "vitest";
import { markMoves, STATE_COLOR, stateMark, type UiState } from "../src/theme/status.ts";

const tagged = {
	fg: (color: string, text: string) => `<${color}>${text}`,
	style: (text: string, options: { fg?: unknown }) => `<rgb ${JSON.stringify(options.fg)}>${text}`,
	colors: { warning: rgbColor(200, 150, 0), dim: rgbColor(80, 80, 80), success: rgbColor(0, 180, 0) },
	appearance: "dark" as const,
};
const states: UiState[] = ["pending", "running", "waiting", "done", "failed", "stopped"];

describe("stateMark", () => {
	afterEach(() => animationClock.setReducedMotion(false));

	it("paints each state with its one glyph and colour role when still", () => {
		animationClock.setReducedMotion(true);
		for (const state of states) expect(stateMark(tagged, state)).toBe(`<${STATE_COLOR[state]}>${GLYPH[state]}`);
		expect(states.map((state) => markMoves(state))).toEqual(states.map(() => false));
	});

	it("spins while running, breathes while waiting, and glows only right after done", () => {
		expect(stateMark(tagged, "running", { now: 0 })).toBe(`<accent>${SPINNER.braille[0]}`);
		expect(stateMark(tagged, "running", { now: MOTION.spinnerMs * 3 })).toBe(`<accent>${SPINNER.braille[3]}`);
		// Breath start: the warning colour itself; mid-breath: a mix toward dim.
		expect(stateMark(tagged, "waiting", { now: 0 })).toBe(`<warning>${GLYPH.waiting}`);
		expect(stateMark(tagged, "waiting", { now: MOTION.breathePeriodMs / 2 })).toMatch(/^<rgb .*>◇$/);
		expect(stateMark(tagged, "done", { now: 100, since: 100 })).toMatch(/^<rgb .*>✓$/);
		expect(stateMark(tagged, "done", { now: 100 + MOTION.flashMs, since: 100 })).toBe("<success>✓");
		expect(markMoves("done", { now: 100 + MOTION.flashMs, since: 100 })).toBe(false);
		expect(markMoves("done", { now: 150, since: 100 })).toBe(true);
		expect(markMoves("running")).toBe(true);
		expect(markMoves("failed")).toBe(false);
	});

	it("falls back to the token colour when the theme has no concrete colours", () => {
		const plain = { fg: tagged.fg };
		expect(stateMark(plain, "waiting", { now: MOTION.breathePeriodMs / 2 })).toBe(`<warning>${GLYPH.waiting}`);
		expect(stateMark(plain, "done", { now: 100, since: 100 })).toBe(`<success>${GLYPH.done}`);
	});
});
