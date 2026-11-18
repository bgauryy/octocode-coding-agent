import { visibleWidth } from "@octocodeai/octocode-tui";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { describe, expect, it } from "vitest";
import type { WorkRow } from "../../src/octocode/shared/running-work.ts";
import { widgetLines } from "../../src/octocode/team/panel/layout.ts";
import { theme } from "./fake-host.ts";

const NOW = 1_000_000_000;
const ME = "sneaky-tide";
const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "implementer",
	pid: process.pid,
	parentId: ME,
	status: "working",
	joinedAt: NOW - 506_000,
	updatedAt: NOW,
	toolCalls: 68,
	input: 280_000,
	cacheRead: 5_400_000,
	output: 60_000,
	cost: 3.34,
	unpriced: false,
	model: "anthropic-custom/claude-opus-5-5:high",
	checkout: "/repo",
	cwd: "/repo",
	...extra,
});
const main = member(ME, { role: "main", parentId: undefined, goal: undefined, cost: 5.5, joinedAt: NOW - 3_600_000 });
const children = [
	member("inky-starfish-2", {
		goal: "B794: testkit guards for context-management flows: clearing, post-compaction restore and summaries",
		activity: "Thinking",
		locks: ["a.ts", "b.ts"],
	}),
	member("zesty-otter-2", {
		goal: "B795: paid (live-model) tests out of every default test script, opt-in test:live only",
		activity: "shell: cd packages/ai && yarn vitest run test/abort.live.test.ts",
		locks: ["packages/ai/test/"],
	}),
	member("cheeky-squid-3", {
		goal: "B796: remove rigid wording tests in every package, assertions on instruction prose",
		status: "idle",
	}),
];
const work: WorkRow[] = [
	{
		kind: "bash",
		id: "bash-28",
		title: "Run every workspace's tests",
		detail: "./test.sh > .octocode/tmp/test.log 2>&1",
		startedAt: NOW - 617_000,
	},
];
const scene = (width: number) =>
	widgetLines([main, ...children], ME, NOW, theme, width, [], 40, [], work, true, "all");

const WIDTHS = [60, 100, 160, 240];
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const headOf = (lines: string[], id: string) => lines.find((line) => plain(line).includes(` ${id} `))!;
/** The goal as one head line shows it: the text after the role column, before the action or the spend gap. */
const shownGoal = (lines: string[], id: string) => {
	const text = plain(headOf(lines, id));
	const start = text.indexOf("B79");
	return start < 0 ? "" : text.slice(start).split(/ › | {2,}/)[0].trim();
};
/** The lines that carry cells right-aligned to the edge: head lines with spend, detail lines and the work row. */
const edgeLines = (lines: string[]) =>
	lines.filter((line) => /\d+m\d+s$|\$\d|tok|cached|tool calls|locks?$/.test(plain(line).trimEnd()));

describe("agents panel width", () => {
	it("ends every row with right-aligned cells at the terminal's edge, the work row's clock included", () => {
		for (const width of WIDTHS) {
			const lines = scene(width);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			const edged = edgeLines(lines);
			// Each child's detail line and the bash row, at least.
			expect(edged.length).toBeGreaterThanOrEqual(children.length + 1);
			for (const line of edged) {
				expect(visibleWidth(line)).toBe(width);
				expect(plain(line).endsWith(" ")).toBe(false);
			}
		}
	});

	it("puts every head line's spend at the edge from 100 columns, so the columns line up down the panel", () => {
		for (const width of WIDTHS.filter((each) => each >= 100)) {
			const lines = scene(width);
			const heads = [ME, ...children.map((child) => child.id)].map((id) => plain(headOf(lines, id)));
			for (const head of heads) expect(visibleWidth(head)).toBe(width);
			// The cost column starts at one cell on every child row.
			expect(new Set(heads.slice(1).map((head) => visibleWidth(head.slice(0, head.indexOf("≈$")))))).toHaveProperty("size", 1);
		}
	});

	it("shows more of each goal on a wider terminal and the whole goal once it fits", () => {
		for (const child of children) {
			const shown = WIDTHS.map((width) => shownGoal(scene(width), child.id).replace(/…$/, ""));
			for (const [index, goal] of shown.entries()) {
				expect(child.goal!.startsWith(goal)).toBe(true);
				if (index > 0) expect(goal.length).toBeGreaterThanOrEqual(shown[index - 1].length);
			}
			expect(shown.at(-1)).toBe(child.goal);
		}
	});

	it("keeps the narrow form under the grid's minimum width", () => {
		const lines = scene(50);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(50);
		// Each agent's goal takes a line of its own under the name.
		for (const child of children) {
			const head = lines.indexOf(headOf(lines, child.id));
			expect(plain(lines[head + 1])).toContain(child.goal!.slice(0, 10));
		}
	});
});
