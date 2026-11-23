import { animationClock, GLYPH, MOTION, rgbColor, SPINNER, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it } from "vitest";
import { LIGHT_COLOR, markFrameMs, markMoves, STATE_COLOR, stateMark, type UiState } from "../src/theme/status.ts";

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

	it("shows a running mark as a still ◌ in reduced motion", () => {
		animationClock.setReducedMotion(true);
		expect(stateMark(tagged, "running")).toBe("<accent>◌");
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
	// The user asked for a running light that animates or shows its state, never a half-filled circle: the frames are
	// the working spinner's.
	const frames = [...SPINNER.braille];
	const frameMs = markFrameMs("running", { light: true });

	it("measures one cell wide", () => {
		expect(visibleWidth(GLYPH.light)).toBe(1);
		expect(GLYPH.light).toBe("\u23FA");
		for (const frame of frames) expect(visibleWidth(frame)).toBe(1);
	});

	// The user asked for "animation OR state": ⏺ means running only, so a settled light draws its state's own glyph.
	it("draws each settled state's own glyph steady in its colour: green ✓, red ✗ or ◼, yellow ◇, grey ○", () => {
		for (const reduced of [true, false]) {
			animationClock.setReducedMotion(reduced);
			for (const now of [0, 1_234, 99_999]) {
				expect(light("pending", { now })).toBe("<dim>○");
				expect(light("done", { now, since: 0 })).toBe("<success>✓");
				expect(light("failed", { now })).toBe("<error>✗");
				expect(light("stopped", { now })).toBe("<error>◼");
				expect(light("waiting", { now, since: 0 })).toBe("<warning>◇");
			}
		}
		expect(LIGHT_COLOR.done).toBe("success");
		expect(LIGHT_COLOR.stopped).toBe("error");
	});

	it("spins the working spinner's frames in one colour while running, without a colour pulse", () => {
		const seen = Array.from({ length: 2 * frames.length }, (_, i) => light("running", { now: i * frameMs }));
		expect(seen.map((mark) => mark.replace(/^<\w+>/, ""))).toEqual([...frames, ...frames]);
		expect(seen.join("")).not.toMatch(/[◒◐◓◑]/);
		expect(new Set(seen.map((mark) => mark.match(/^<\w+>/)?.[0])).size).toBe(1);
		expect(seen.join("")).not.toContain("rgb");
	});

	it("shows a running light as a full steady ⏺ in green in reduced motion, never a frame held still", () => {
		animationClock.setReducedMotion(true);
		expect(light("running", { now: 0 })).toBe(light("running", { now: 5 * frameMs }));
		expect(light("running", { now: 0 })).toBe("<success>⏺");
	});

	it("repaints only while a spinner runs", () => {
		const moves = (state: UiState, options = {}) => markMoves(state, { light: true, ...options });
		expect(moves("running")).toBe(true);
		for (const state of states.filter((s) => s !== "running")) {
			expect(moves(state, { now: 100, since: 100 })).toBe(false);
			expect(moves(state)).toBe(false);
		}
		animationClock.setReducedMotion(true);
		expect(moves("running")).toBe(false);
	});

	it("repaints a running light calmly: at the background pace, never faster than a glow frame", () => {
		expect(frameMs).toBeGreaterThanOrEqual(MOTION.glowFrameMs);
		expect(frameMs).toBeGreaterThanOrEqual(MOTION.backgroundSpinnerMs);
		expect(markFrameMs("running")).toBe(MOTION.spinnerMs);
	});
});
