import type { Member } from "@octocodeai/octocode-contracts/team";
import { activity } from "@octocodeai/octocode-projections";
import { animationClock, GLYPH, LIGHT_GLYPH, MOTION, SPINNER } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it } from "vitest";
import { moreLine } from "../../src/octocode/team/panel/rows.ts";
import { footerLines } from "../../src/octocode/ui/footer/rows.ts";
import { activityBadge } from "../../src/theme/page-kit.ts";
import { activityMark, markMoves, stateMark, stillLight } from "../../src/theme/status.ts";
import { openWidgetLines as widgetLines } from "./two-line-panel.ts";
import { theme } from "./fake-host.ts";

/**
 * The rule for a running state: a full still ⏺ on every surface, with motion on or reduced; never a spinner frame and
 * never a half-filled circle (◐ is the waiting light). One mapping drives every terminal surface, so each is checked here.
 */
const HALF = /[◒◐◓◑]/;
const BRAILLE = new RegExp(`[${SPINNER.braille.join("")}]`);
const NOW = 1_000_000;
const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "general",
	pid: process.pid,
	status: "idle",
	joinedAt: NOW - 60_000,
	updatedAt: NOW,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});
const team = [member("main-aaaa"), member("busy-bbbb", { parentId: "main-aaaa", status: "working" })];
const colourless = { fg: (_tone: string, text: string) => text, getColorMode: () => "none" };
const plain = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };

afterEach(() => animationClock.setReducedMotion(false));

describe("the running light on every surface", () => {
	it("holds the full ⏺ still with motion on, on rows and the agents panel, at every spinner frame time", () => {
		animationClock.setReducedMotion(false);
		expect(markMoves("running", { light: true })).toBe(false);
		for (let frame = 0; frame < SPINNER.braille.length * 2; frame++) {
			const now = NOW + frame * MOTION.spinnerMs;
			const mark = stateMark(theme, "running", { light: true, now });
			expect(mark).toBe(LIGHT_GLYPH.running);
			expect(mark).toBe(stillLight(theme, "running"));
			const panel = widgetLines(team, "main-aaaa", now, theme, 120).join("\n");
			expect(panel).toContain(`${LIGHT_GLYPH.running} busy-bbbb`);
			expect(panel).not.toMatch(BRAILLE);
			expect(panel).not.toMatch(HALF);
		}
	});

	it("draws the same full ⏺ in reduced motion, lists, the footer and `+N more`", () => {
		animationClock.setReducedMotion(true);
		expect(LIGHT_GLYPH.running).toBe("⏺");
		expect(stateMark(colourless, "running", { light: true, now: NOW })).toBe(LIGHT_GLYPH.running);
		const panel = widgetLines(team, "main-aaaa", NOW, theme, 120).join("\n");
		expect(panel).toContain(`${LIGHT_GLYPH.running} busy-bbbb`);
		expect(panel).not.toMatch(HALF);
		animationClock.setReducedMotion(false);
		// Still surfaces stay full even with motion on.
		expect(stillLight(colourless, "running")).toBe(LIGHT_GLYPH.running);
		expect(activityMark(colourless, activity({ streaming: true }))).toBe(`${LIGHT_GLYPH.running} working`);
		expect(activityBadge("working").text).toBe(`${LIGHT_GLYPH.running} working`);
		const footer = footerLines(
			{
				model: "m",
				usage: { input: 0, cacheRead: 0, output: 0, cost: 0, unpriced: false },
				cwd: "/w",
				activity: activity({ streaming: true }),
			},
			"main",
			new Map(),
			plain,
			80,
		).join("\n");
		expect(footer).toContain(`${LIGHT_GLYPH.running} working`);
		const more = moreLine([{ member: team[1], depth: 1 }], NOW, theme, 80);
		expect(more).toContain(LIGHT_GLYPH.running);
		for (const text of [footer, more]) expect(text).not.toMatch(HALF);
	});

	it("keeps settled lights apart without colour, and the working ⏺ apart from every settled glyph", () => {
		const shown = (["pending", "waiting", "done", "failed", "stopped"] as const).map((state) =>
			stillLight(colourless, state),
		);
		expect(shown).toEqual(["○", "◐", "◉", "⊗", "⊘"]);
		expect(new Set(shown).size).toBe(shown.length);
		expect(shown).not.toContain(stillLight(colourless, "running"));
	});

	it("never draws ⏺ for a settled state, in colour or not, moving or still: a done light is ◉ everywhere", () => {
		const settled = ["pending", "waiting", "done", "failed", "stopped"] as const;
		const tagged = { fg: (tone: string, text: string) => `<${tone}>${text}`, getColorMode: () => "truecolor" };
		const finished = (outcome: "done" | "failed" | "stopped") => ({
			member: member(`gone-${outcome}`, { parentId: "main-aaaa" }),
			at: NOW - 1_000,
			end: { outcome },
		});
		for (const reduced of [false, true]) {
			animationClock.setReducedMotion(reduced);
			for (const paint of [theme, tagged, colourless]) {
				for (const state of settled) {
					const marks = [stateMark(paint, state, { light: true, now: NOW, since: NOW }), stillLight(paint, state)];
					for (const mark of marks) expect(mark, `${state} reduced=${reduced}`).not.toContain(LIGHT_GLYPH.running);
				}
				expect(stillLight(paint, "done")).toContain("◉");
			}
			// The agents panel's finished rows and its `+N more` count.
			const panel = widgetLines([team[0]], "main-aaaa", NOW, theme, 120, [], undefined, [
				finished("done"),
				finished("failed"),
				finished("stopped"),
			] as never).join("\n");
			expect(panel).toMatch(/◉ gone-done/);
			expect(panel).toMatch(/⊗ gone-failed/);
			expect(panel).toMatch(/⊘ gone-stopped/);
			expect(panel).not.toContain(LIGHT_GLYPH.running);
			const doneEntry = { member: member("gone-x"), depth: 1, doneAt: NOW, end: { outcome: "done" as const } };
			const more = moreLine([doneEntry], NOW, tagged as never, 80);
			expect(more).toContain("<muted>◉");
			expect(more).not.toContain(LIGHT_GLYPH.running);
		}
		// Lists and the footer: a done or idle session reads ○ with its word, never ⏺.
		expect(activityBadge("idle").text).toBe(`${GLYPH.pending} idle`);
		const footer = footerLines(
			{
				model: "m",
				usage: { input: 0, cacheRead: 0, output: 0, cost: 0, unpriced: false },
				cwd: "/w",
				activity: activity({ phase: { state: "done" } }),
			},
			"main",
			new Map(),
			plain,
			80,
		).join("\n");
		expect(footer).not.toContain(LIGHT_GLYPH.running);
	});
});
