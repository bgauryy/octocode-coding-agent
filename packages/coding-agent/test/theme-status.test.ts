import { animationClock, GLYPH, MOTION, rgbColor, SPINNER, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
	LIGHT_COLOR,
	markFrameMs,
	markMoves,
	STATE_COLOR,
	stateMark,
	WAIT_PULSE_MS,
	type UiState,
} from "../src/theme/status.ts";

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

	it("tones stopped like the stopped row text, with a glyph waiting does not share", () => {
		expect(STATE_COLOR.waiting).toBe("warning");
		expect(STATE_COLOR.stopped).toBe("warning");
		expect(STATE_COLOR.stopped).not.toBe(STATE_COLOR.pending);
		expect(GLYPH.stopped).not.toBe(GLYPH.waiting);
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

describe("the state light", () => {
	afterEach(() => animationClock.setReducedMotion(false));
	const light = (state: UiState, options = {}) => stateMark(tagged, state, { light: true, ...options });

	it("measures one cell wide", () => {
		expect(visibleWidth(GLYPH.light)).toBe(1);
		expect(GLYPH.light).toBe("\u23FA");
	});

	it("draws ⏺ in each state's light colour: green works, yellow waits, red fails or stops, dim is unlit", () => {
		animationClock.setReducedMotion(true);
		expect(states.map((state) => light(state))).toEqual([
			"<dim>⏺",
			"<success>⏺",
			"<warning>⏺",
			"<success>⏺",
			"<error>⏺",
			"<error>⏺",
		]);
		expect(LIGHT_COLOR.running).toBe("success");
		expect(states.map((state) => markMoves(state, { light: true }))).toEqual(states.map(() => false));
	});

	it("breathes while running, holds a waiting light after its pulse, and settles after done", () => {
		const start = light("running", { now: 0 });
		const mid = light("running", { now: MOTION.breathePeriodMs / 2 });
		expect(start).toBe("<success>⏺");
		expect(mid).toMatch(/^<rgb .*>⏺$/);
		expect(mid).not.toBe(start);
		expect(light("waiting", { now: WAIT_PULSE_MS + 1, since: 0 })).toBe("<warning>⏺");
		expect(light("waiting", { now: MOTION.breathePeriodMs / 2, since: 0 })).toMatch(/^<rgb .*>⏺$/);
		expect(light("done", { now: 100, since: 100 })).toMatch(/^<rgb .*>⏺$/);
		expect(light("done", { now: 100 + MOTION.flashMs, since: 100 })).toBe("<success>⏺");
		expect(light("running", { now: 0 })).not.toContain(SPINNER.braille[0]);
	});

	it("repaints a running light calmly: at the background pace, never faster than a glow frame", () => {
		const ms = markFrameMs("running", { light: true });
		expect(ms).toBeGreaterThanOrEqual(MOTION.glowFrameMs);
		expect(ms).toBeGreaterThanOrEqual(MOTION.backgroundSpinnerMs);
		expect(markFrameMs("running")).toBe(MOTION.spinnerMs);
	});
});
