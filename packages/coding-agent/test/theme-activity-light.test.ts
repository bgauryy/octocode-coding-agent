import { activity } from "@octocodeai/octocode-projections";
import { animationClock, GLYPH, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it } from "vitest";
import { activityBadge } from "../src/theme/page-kit.ts";
import { activityMark, LIGHT_COLOR, LIGHT_FRAMES, stateMark, stillLight, type UiState } from "../src/theme/status.ts";
import { loadTheme } from "../src/theme/theme-loader.ts";

const tagged = (mode = "truecolor") => ({
	fg: (color: string, text: string) => `<${color}>${text}`,
	getColorMode: () => mode,
});
const states: UiState[] = ["pending", "running", "waiting", "done", "failed", "stopped"];
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("activity lights", () => {
	afterEach(() => animationClock.setReducedMotion(false));

	it("are green while working, yellow when they need the user, red on failure or stop, dim when idle", () => {
		expect(LIGHT_COLOR).toMatchObject({
			running: "success",
			waiting: "warning",
			failed: "error",
			stopped: "error",
			pending: "dim",
		});
		// Still, a working light is the full ⏺ in green: never a spinner frame held still, which reads as half done.
		// ⏺ means running only: each settled light draws its state's glyph in its colour.
		expect(stillLight(tagged(), "running")).toBe(`<success>${GLYPH.light}`);
		expect(stillLight(tagged(), "waiting")).toBe(`<warning>${GLYPH.waiting}`);
		expect(stillLight(tagged(), "failed")).toBe(`<error>${GLYPH.failed}`);
		expect(stillLight(tagged(), "pending")).toBe(`<dim>${GLYPH.pending}`);
	});

	it("draw each state's own glyph without colour (NO_COLOR), never one dot for all", () => {
		const none = tagged("none");
		const glyphs = states.map((state) => stillLight(none, state).replace(/^<\w+>/, ""));
		expect(new Set(glyphs).size).toBe(states.length);
		// Without colour no settled state uses ⏺, so the full ⏺ stands for working.
		expect(glyphs).toEqual([GLYPH.pending, GLYPH.light, GLYPH.waiting, GLYPH.done, GLYPH.failed, GLYPH.stopped]);
		for (const glyph of glyphs) expect(visibleWidth(glyph)).toBe(1);
		// A settled light takes its glyph in motion and in reduced motion alike; a running one spins the working spinner,
		// or holds the full ⏺ in reduced motion.
		for (const reduced of [false, true]) {
			animationClock.setReducedMotion(reduced);
			expect(stateMark(none, "failed", { light: true, now: 0 })).toBe(`<error>${GLYPH.failed}`);
			expect(stateMark(none, "waiting", { light: true, now: 0, since: 0 })).toBe(`<warning>${GLYPH.waiting}`);
			const running = stateMark(none, "running", { light: true, now: 0 }).replace(/^<\w+>/, "");
			expect(running).toBe(reduced ? GLYPH.light : LIGHT_FRAMES[0]);
		}
	});

	it("tell the states apart in a real theme without colour, as plain text", () => {
		const theme = loadTheme("octocode-dark", "none");
		const shown = states.map((state) => stillLight(theme, state));
		for (const mark of shown) expect(mark).not.toContain("\x1b[3");
		expect(new Set(shown.map(strip)).size).toBe(states.length);
		// In colour each settled light keeps its glyph too: the colour adds to the shape, never replaces it.
		const coloured = loadTheme("octocode-dark", "16color");
		expect(strip(stillLight(coloured, "failed"))).toBe(GLYPH.failed);
		expect(strip(stillLight(coloured, "done"))).toBe(GLYPH.done);
		expect(strip(stillLight(coloured, "running"))).toBe(GLYPH.light);
		expect(stillLight(coloured, "failed")).not.toBe(stillLight(coloured, "done"));
		expect(stillLight(coloured, "waiting")).not.toBe(stillLight(coloured, "pending"));
	});

	it("say a word beside the light, loud only when it asks for attention", () => {
		expect(activityMark(tagged(), activity({ awaiting: true }))).toBe(`<warning>${GLYPH.waiting} <warning>needs you`);
		expect(activityMark(tagged(), activity({ phase: { state: "failed", error: "x" } }))).toBe(
			`<error>${GLYPH.failed} <error>failed`,
		);
		expect(activityMark(tagged(), activity({ status: "retrying" }))).toBe(`<success>${GLYPH.light} <muted>retrying`);
		expect(activityMark(tagged(), activity({}))).toBe(`<dim>${GLYPH.pending} <dim>idle`);
		expect(activityMark(tagged(), activity({}), false)).toBe(`<dim>${GLYPH.pending}`);
	});

	it("give pages a glyph and a word per activity, each glyph distinct", () => {
		const tones = ["working", "waiting", "error", "idle"] as const;
		const badges = tones.map((tone) => activityBadge(tone));
		expect(badges.map((badge) => badge.text)).toEqual(["⏺ working", "◇ needs you", "✗ failed", "○ idle"]);
		expect(badges.map((badge) => badge.tone)).toEqual(["success", "warning", "error", "muted"]);
		expect(activityBadge("error", "stopped").text).toBe("✗ stopped");
		expect(() => activityBadge("nope" as never)).toThrow("Unknown activity");
	});
});
