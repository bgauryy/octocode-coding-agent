import type { Member } from "@octocodeai/octocode-contracts/team";
import { animationClock, GLYPH } from "@octocodeai/octocode-tui";
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
	{ member: member("b"), depth: 1, need: { kind: "approval", count: 1, since: NOW } },
	{ member: member("c"), depth: 1, doneAt: NOW, end: { outcome: "failed" } },
	{ member: member("d"), depth: 1, doneAt: NOW, end: { outcome: "done" } },
	{ member: member("e", "idle"), depth: 1 },
];

describe("agents panel lights", () => {
	afterEach(() => animationClock.setReducedMotion(false));

	it("draws a working child green, one that needs you yellow, a failed one red and an idle one dim", () => {
		animationClock.setReducedMotion(true);
		const marks = hidden.map((entry) => panelMark(tagged(), panelState(entry, NOW), NOW));
		expect(marks).toEqual([
			// Reduced motion: the working child's light is the full ⏺, never a spinner frame held still; every settled
			// child draws its state's glyph, so ⏺ means running only.
			`<success>${GLYPH.light}`,
			`<warning>${GLYPH.waiting}`,
			`<error>${GLYPH.failed}`,
			`<success>${GLYPH.done}`,
			`<dim>${GLYPH.pending}`,
		]);
	});

	it("draws each state's own glyph without colour, in the rows and in the `+N more` count", () => {
		animationClock.setReducedMotion(true);
		const marks = hidden.map((entry) => panelMark(tagged("none"), panelState(entry, NOW), NOW).replace(/^<\w+>/, ""));
		expect(marks).toEqual([GLYPH.light, GLYPH.waiting, GLYPH.failed, GLYPH.done, GLYPH.pending]);
		const more = moreLine(hidden, NOW, tagged("none"), 400).replace(/<\w+>/g, "");
		expect(more).toBe(
			` +5 more · ${GLYPH.waiting} 1 ${GLYPH.failed} 1 ${GLYPH.light} 1 ${GLYPH.done} 1 ${GLYPH.pending} 1`,
		);
		// In colour the count keeps each state's glyph, coloured, and warns while one waits; ⏺ only for running.
		expect(moreLine(hidden, NOW, tagged(), 400)).toContain(`<warning>${GLYPH.waiting}<warning> 1`);
		expect(moreLine(hidden, NOW, tagged(), 400)).toContain(`<success>${GLYPH.done}<warning> 1`);
		expect(moreLine(hidden, NOW, tagged(), 400)).toContain(`<success>${GLYPH.light}`);
		expect(moreLine(hidden, NOW, tagged(), 400)).not.toMatch(/[◒◐◓◑]/);
	});
});
