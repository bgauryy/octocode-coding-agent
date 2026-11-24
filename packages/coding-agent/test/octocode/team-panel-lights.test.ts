import type { Member } from "@octocodeai/octocode-contracts/team";
import { animationClock, LIGHT_GLYPH } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it } from "vitest";
import { moreLine } from "../../src/octocode/team/panel/rows.ts";
import { type PanelEntry, panelMark, panelState } from "../../src/octocode/team/panel/state.ts";

const NOW = 1_000_000;
const member = (id: string, status: Member["status"] = "working"): Member => ({
	id,
	role: "general",
	parentId: "main",
	pid: 1,
	status,
	joinedAt: NOW - 60_000,
	updatedAt: NOW,
	toolCalls: 3,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
});
const tagged = (mode = "truecolor") =>
	({ fg: (tone: string, text: string) => `<${tone}>${text}`, getColorMode: () => mode }) as never;
const hidden: PanelEntry[] = [
	{ member: member("a"), depth: 1 },
	{ member: member("b"), depth: 1, need: { kind: "approval", count: 1 } },
	{ member: member("c"), depth: 1, doneAt: NOW, end: { outcome: "failed" } },
	{ member: member("d"), depth: 1, doneAt: NOW, end: { outcome: "done" } },
	{ member: member("e", "idle"), depth: 1 },
];

describe("agents panel lights", () => {
	afterEach(() => animationClock.setReducedMotion(false));

	it("draws a working child green, one that needs you yellow, a failed one red, a done one quiet and an idle one dim", () => {
		// Each state has its own circle, so ⏺ (green) means running only. A light never moves: the same string with
		// motion on or reduced.
		const lights = [
			`<success>${LIGHT_GLYPH.running}`,
			`<warning>${LIGHT_GLYPH.waiting}`,
			`<error>${LIGHT_GLYPH.failed}`,
			`<muted>${LIGHT_GLYPH.done}`,
			`<dim>${LIGHT_GLYPH.pending}`,
		];
		expect(lights).toEqual(["<success>⏺", "<warning>◐", "<error>⊗", "<muted>◉", "<dim>○"]);
		expect(hidden.map((entry) => panelMark(tagged(), panelState(entry, NOW)))).toEqual(lights);
		animationClock.setReducedMotion(true);
		expect(hidden.map((entry) => panelMark(tagged(), panelState(entry, NOW)))).toEqual(lights);
	});

	it("draws each state's own glyph without colour, in the rows and in the `+N more` count", () => {
		animationClock.setReducedMotion(true);
		const marks = hidden.map((entry) => panelMark(tagged("none"), panelState(entry, NOW)).replace(/^<\w+>/, ""));
		expect(marks).toEqual([
			LIGHT_GLYPH.running,
			LIGHT_GLYPH.waiting,
			LIGHT_GLYPH.failed,
			LIGHT_GLYPH.done,
			LIGHT_GLYPH.pending,
		]);
		const more = moreLine(hidden, NOW, tagged("none"), 400).replace(/<\w+>/g, "");
		expect(more).toBe(
			` +5 more · ${LIGHT_GLYPH.waiting} 1 ${LIGHT_GLYPH.failed} 1 ${LIGHT_GLYPH.running} 1 ${LIGHT_GLYPH.done} 1 ${LIGHT_GLYPH.pending} 1`,
		);
		// In colour the count keeps each state's glyph, coloured, and warns while one waits; ⏺ only for running.
		expect(moreLine(hidden, NOW, tagged(), 400)).toContain(`<warning>${LIGHT_GLYPH.waiting}<warning> 1`);
		expect(moreLine(hidden, NOW, tagged(), 400)).toContain(`<muted>${LIGHT_GLYPH.done}<warning> 1`);
		expect(moreLine(hidden, NOW, tagged(), 400)).toContain(`<success>${LIGHT_GLYPH.running}`);
		// No spinner frame and none of the old outcome marks stand in for a light.
		expect(moreLine(hidden, NOW, tagged(), 400)).not.toMatch(/[◒◓◑⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✓✗◇◼]/);
	});
});
