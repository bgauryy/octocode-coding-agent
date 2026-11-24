import { animationClock, GLYPH, LIGHT_GLYPH, MOTION, rgbColor, SPINNER, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it } from "vitest";
import { LIGHT_COLOR, MARK_FRAME_MS, markMoves, STATE_COLOR, stateMark, type UiState } from "../src/theme/status.ts";

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

	it("shows a running mark as a still ⏺ in reduced motion, the same as with motion on", () => {
		animationClock.setReducedMotion(true);
		expect(stateMark(tagged, "running")).toBe("<accent>⏺");
		animationClock.setReducedMotion(false);
		expect(stateMark(tagged, "running")).toBe("<accent>⏺");
		expect(GLYPH.running).toBe("⏺");
	});

	it("tones stopped like the stopped row text, with a glyph waiting does not share", () => {
		expect(STATE_COLOR.waiting).toBe("warning");
		expect(STATE_COLOR.stopped).toBe("warning");
		expect(STATE_COLOR.stopped).not.toBe(STATE_COLOR.pending);
		expect(GLYPH.stopped).not.toBe(GLYPH.waiting);
	});

	it("holds still while running, breathes while waiting, and glows only right after done", () => {
		// A running mark is the full dot at every frame time: never a spinner frame.
		for (let frame = 0; frame < SPINNER.braille.length; frame++)
			expect(stateMark(tagged, "running", { now: MOTION.spinnerMs * frame })).toBe("<accent>⏺");
		// Breath start: the warning colour itself; mid-breath: a mix toward dim.
		expect(stateMark(tagged, "waiting", { now: 0 })).toBe(`<warning>${GLYPH.waiting}`);
		expect(stateMark(tagged, "waiting", { now: MOTION.breathePeriodMs / 2 })).toMatch(/^<rgb .*>◇$/);
		expect(stateMark(tagged, "done", { now: 100, since: 100 })).toMatch(/^<rgb .*>✓$/);
		expect(stateMark(tagged, "done", { now: 100 + MOTION.flashMs, since: 100 })).toBe("<success>✓");
		expect(markMoves("done", { now: 100 + MOTION.flashMs, since: 100 })).toBe(false);
		expect(markMoves("done", { now: 150, since: 100 })).toBe(true);
		expect(markMoves("running")).toBe(false);
		expect(markMoves("failed")).toBe(false);
		// A waiting mark pulses for its first four seconds, then holds still.
		expect(markMoves("waiting")).toBe(true);
		expect(markMoves("waiting", { now: 3_999, since: 0 })).toBe(true);
		expect(markMoves("waiting", { now: 4_000, since: 0 })).toBe(false);
		expect(stateMark(tagged, "waiting", { now: 4_000 + MOTION.breathePeriodMs / 2, since: 0 })).toBe("<warning>◇");
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
	// A running light is the full ⏺, still: never a spinner frame, never a half-filled circle. These are the frame times
	// the working spinner would turn at.
	const frames = [...SPINNER.braille];
	const frameMs = MOTION.spinnerMs;

	it("measures one cell wide", () => {
		expect(visibleWidth(LIGHT_GLYPH.running)).toBe(1);
		expect(LIGHT_GLYPH.running).toBe("\u23FA");
		for (const state of states) expect(visibleWidth(LIGHT_GLYPH[state])).toBe(1);
		for (const frame of frames) expect(visibleWidth(frame)).toBe(1);
	});

	// ⏺ means running only, so a settled light draws its state's own circle.
	it("draws each settled state's own circle steady in its colour: quiet ◉, red ⊗ or ⊘, yellow ◐, grey ○", () => {
		for (const reduced of [true, false]) {
			animationClock.setReducedMotion(reduced);
			for (const now of [0, 1_234, 99_999]) {
				expect(light("pending", { now })).toBe("<dim>○");
				expect(light("done", { now, since: 0 })).toBe("<muted>◉");
				expect(light("done", { now, since: now })).toBe("<muted>◉");
				expect(light("failed", { now })).toBe("<error>⊗");
				expect(light("stopped", { now })).toBe("<error>⊘");
				expect(light("waiting", { now, since: 0 })).toBe("<warning>◐");
				expect(light("waiting", { now })).toBe("<warning>◐");
			}
		}
		expect(LIGHT_COLOR.done).toBe("muted");
		expect(LIGHT_COLOR.stopped).toBe("error");
	});

	it("holds the full ⏺ in one colour while running, at every spinner frame time, without a colour pulse", () => {
		const seen = Array.from({ length: 2 * frames.length }, (_, i) => light("running", { now: i * frameMs }));
		expect(seen).toEqual(seen.map(() => "<success>⏺"));
		for (const frame of frames) expect(seen.join("")).not.toContain(frame);
		expect(seen.join("")).not.toMatch(/[◒◐◓◑]/);
		expect(new Set(seen.map((mark) => mark.match(/^<\w+>/)?.[0])).size).toBe(1);
		expect(seen.join("")).not.toContain("rgb");
	});

	it("shows a running light as a full steady ⏺ in green in reduced motion, never a frame held still", () => {
		animationClock.setReducedMotion(true);
		expect(light("running", { now: 0 })).toBe(light("running", { now: 5 * frameMs }));
		expect(light("running", { now: 0 })).toBe("<success>⏺");
	});

	it("never repaints: no light moves in any state, running included", () => {
		const moves = (state: UiState, options = {}) => markMoves(state, { light: true, ...options });
		for (const reduced of [false, true]) {
			animationClock.setReducedMotion(reduced);
			for (const state of states) {
				expect(moves(state, { now: 100, since: 100 })).toBe(false);
				expect(moves(state)).toBe(false);
			}
		}
	});

	it("repaints a moving outcome mark (a waiting pulse, a done flash) at the glow pace, never faster", () => {
		expect(MARK_FRAME_MS).toBe(MOTION.glowFrameMs);
		expect(MARK_FRAME_MS).toBeGreaterThanOrEqual(MOTION.spinnerMs);
	});
});
