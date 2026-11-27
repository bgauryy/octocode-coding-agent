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

	it("draws done green, failures red, waiting and idle steady yellow, and a working child pulsing yellow and grey", () => {
		// Each state keeps its own circle; only the colour carries the four lights.
		const at = (entry: PanelEntry, now = NOW) => panelMark(tagged(), panelState(entry, now), now);
		const [working, needs, failed, done, idle] = hidden;
		const stopped: PanelEntry = { member: member("f"), depth: 1, doneAt: NOW, end: { outcome: "stopped" } };
		const blocked: PanelEntry = { member: member("g"), depth: 1, doneAt: NOW, end: { outcome: "blocked" } };
		const partial: PanelEntry = { member: member("h"), depth: 1, doneAt: NOW, end: { outcome: "partial" } };
		const left: PanelEntry = { member: member("i"), depth: 1, doneAt: NOW };
		expect([done, partial].map((entry) => at(entry))).toEqual([
			`<success>${LIGHT_GLYPH.done}`,
			`<success>${LIGHT_GLYPH.done}`,
		]);
		expect([failed, stopped].map((entry) => at(entry))).toEqual([
			`<error>${LIGHT_GLYPH.failed}`,
			`<error>${LIGHT_GLYPH.stopped}`,
		]);
		expect([needs, blocked].map((entry) => at(entry))).toEqual([
			`<warning>${LIGHT_GLYPH.waiting}`,
			`<warning>${LIGHT_GLYPH.waiting}`,
		]);
		expect([idle, left].map((entry) => at(entry))).toEqual([
			`<warning>${LIGHT_GLYPH.pending}`,
			`<warning>${LIGHT_GLYPH.pending}`,
		]);
		// Steady lights do not change from one second to the next; the working light alternates.
		for (const entry of [needs, failed, done, idle]) expect(at(entry, NOW + 1_000)).toBe(at(entry, NOW));
		const frames = [0, 1, 2, 3].map((second) => at(working, NOW + second * 1_000));
		expect(new Set(frames)).toEqual(new Set([`<warning>${LIGHT_GLYPH.running}`, `<muted>${LIGHT_GLYPH.running}`]));
		expect(frames[0]).not.toBe(frames[1]);
		expect(frames[0]).toBe(frames[2]);
		expect(frames[1]).toBe(frames[3]);
		// Reduced motion holds the first colour.
		animationClock.setReducedMotion(true);
		expect([0, 1].map((second) => at(working, NOW + second * 1_000))).toEqual([
			`<warning>${LIGHT_GLYPH.running}`,
			`<warning>${LIGHT_GLYPH.running}`,
		]);
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
		expect(moreLine(hidden, NOW, tagged(), 400)).toContain(`<success>${LIGHT_GLYPH.done}<warning> 1`);
		expect(moreLine(hidden, NOW, tagged(), 400)).toContain(`${LIGHT_GLYPH.running}<warning> 1`);
		// No spinner frame and none of the old outcome marks stand in for a light.
		expect(moreLine(hidden, NOW, tagged(), 400)).not.toMatch(/[◒◓◑⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✓✗◇◼]/);
	});
});
