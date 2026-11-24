import { activity } from "@octocodeai/octocode-projections";
import { animationClock, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it } from "vitest";
import { activityBadge } from "../src/theme/page-kit.ts";
import { activityMark, LIGHT_COLOR, stateMark, stillLight, type UiState } from "../src/theme/status.ts";
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
		expect(LIGHT_COLOR).toEqual({
			running: "success",
			waiting: "warning",
			done: "muted",
			failed: "error",
			stopped: "error",
			pending: "dim",
		});
		// Still, a working light is the full ⏺ in green: never a spinner frame held still, which reads as half done.
		// ⏺ means running only: each settled light draws its state's circle in its colour.
		expect(stillLight(tagged(), "running")).toBe("<success>⏺");
		expect(stillLight(tagged(), "waiting")).toBe("<warning>◐");
		expect(stillLight(tagged(), "failed")).toBe("<error>⊗");
		expect(stillLight(tagged(), "pending")).toBe("<dim>○");
	});

	it("draw each state's own glyph without colour (NO_COLOR), never one dot for all", () => {
		const none = tagged("none");
		const glyphs = states.map((state) => stillLight(none, state).replace(/^<\w+>/, ""));
		expect(new Set(glyphs).size).toBe(states.length);
		// Without colour no settled state uses ⏺, so the full ⏺ stands for working.
		expect(glyphs).toEqual(["○", "⏺", "◐", "◉", "⊗", "⊘"]);
		for (const glyph of glyphs) expect(visibleWidth(glyph)).toBe(1);
		// Every light takes its glyph in motion and in reduced motion alike: a running one holds the full ⏺, never a
		// spinner frame.
		for (const reduced of [false, true]) {
			animationClock.setReducedMotion(reduced);
			expect(stateMark(none, "failed", { light: true, now: 0 })).toBe("<error>⊗");
			expect(stateMark(none, "waiting", { light: true, now: 0, since: 0 })).toBe("<warning>◐");
			for (const now of [0, 100, 250, 1_234])
				expect(stateMark(none, "running", { light: true, now })).toBe("<success>⏺");
		}
	});

	it("tell the states apart in a real theme without colour, as plain text", () => {
		const theme = loadTheme("octocode-dark", "none");
		const shown = states.map((state) => stillLight(theme, state));
		for (const mark of shown) expect(mark).not.toContain("\x1b[3");
		expect(new Set(shown.map(strip)).size).toBe(states.length);
		// In colour each settled light keeps its glyph too: the colour adds to the shape, never replaces it.
		const coloured = loadTheme("octocode-dark", "16color");
		expect(strip(stillLight(coloured, "failed"))).toBe("⊗");
		expect(strip(stillLight(coloured, "done"))).toBe("◉");
		expect(strip(stillLight(coloured, "running"))).toBe("⏺");
		expect(stillLight(coloured, "failed")).not.toBe(stillLight(coloured, "done"));
		expect(stillLight(coloured, "waiting")).not.toBe(stillLight(coloured, "pending"));
	});

	it("say a word beside the light, loud only when it asks for attention", () => {
		expect(activityMark(tagged(), activity({ awaiting: true }))).toBe("<warning>◐ <warning>needs you");
		expect(activityMark(tagged(), activity({ phase: { state: "failed", error: "x" } }))).toBe("<error>⊗ <error>failed");
		expect(activityMark(tagged(), activity({ status: "retrying" }))).toBe("<success>⏺ <muted>retrying");
		expect(activityMark(tagged(), activity({}))).toBe("<dim>○ <dim>idle");
		expect(activityMark(tagged(), activity({}), false)).toBe("<dim>○");
	});

	it("give pages a glyph and a word per activity, each glyph distinct", () => {
		const tones = ["working", "waiting", "error", "idle"] as const;
		const badges = tones.map((tone) => activityBadge(tone));
		expect(badges.map((badge) => badge.text)).toEqual(["⏺ working", "◐ needs you", "⊗ failed", "○ idle"]);
		expect(badges.map((badge) => badge.tone)).toEqual(["success", "warning", "error", "muted"]);
		expect(activityBadge("error", "stopped").text).toBe("⊗ stopped");
		expect(() => activityBadge("nope" as never)).toThrow("Unknown activity");
	});
});
