import type { Member } from "@octocodeai/octocode-contracts/team";
import { beforeAll, describe, expect, it } from "vitest";
import { widgetRows } from "../../src/octocode/team/panel/layout.ts";
import { activityText } from "../../src/octocode/team/panel/activity.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { theme } from "./fake-host.ts";

const NOW = 1_000_000_000;
const agent = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "implementer",
	pid: process.pid,
	status: "working",
	parentId: "main-0001",
	joinedAt: NOW - 537_000,
	updatedAt: NOW,
	toolCalls: 42,
	// Every prompt token: 200k new ones and 3.9M read from cache.
	input: 4_100_000,
	cacheRead: 3_900_000,
	output: 9_000,
	cost: 1,
	unpriced: false,
	model: "claude-sonnet-5-5:medium",
	goal: "B607: Sonnet LLM-judge eval",
	activity: "shell: cd /Users/me/code/repo && yarn vitest run",
	locks: ["a", "b"],
	cwd: "/Users/me/code/repo",
	...extra,
});
const main = agent("main-0001", { role: "main", parentId: undefined, status: "idle", goal: undefined });
const team = [main, agent("sneaky-dolphin"), agent("wily-kelp", { activity: undefined, status: "idle" })];
const strip = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");

describe("team panel: one grid row per agent", () => {
	beforeAll(() => initTheme("dark"));

	it("shows name, role:effort, elapsed, cost, goal and action on one row, without the stats or a state word", () => {
		const { lines } = widgetRows(team, "main-0001", NOW, theme, 140);
		const row = strip(lines.find((line) => line.includes("sneaky-dolphin"))!);
		expect(row).toMatch(/implementer:medium · 8m57s ≈\$1\.00 · B607: Sonnet LLM-judge eval +› shell: yarn vitest run$/);
		for (const hidden of ["claude-sonnet", "tok", "cached", "tool calls", "locks", "working"])
			expect(row).not.toContain(hidden);
		expect(lines).toHaveLength(3);
		// An idle agent's mark says it: no state word.
		expect(strip(lines[2])).toMatch(/^ └ ○ wily-kelp/);
		expect(strip(lines[2])).not.toContain("idle");
	});

	it("opens an agent's detail line when expanded, and maps each row to its agent", () => {
		const open = widgetRows(
			team,
			"main-0001",
			NOW,
			theme,
			140,
			[],
			undefined,
			[],
			[],
			true,
			new Set(["sneaky-dolphin"]),
		);
		const text = open.lines.map(strip);
		expect(text).toHaveLength(4);
		expect(text[2]).toMatch(/^ │ {3}claude-sonnet-5-5:medium · 209k tok · \d+% cached · 42 tool calls · 2 locks$/);
		expect(open.owners).toEqual([undefined, "sneaky-dolphin", "sneaky-dolphin", "wily-kelp"]);
	});

	it("keeps rows within the width at 80 and 60 columns, the action on its own ↳ line", () => {
		for (const width of [80, 60]) {
			const { lines, owners } = widgetRows(team, "main-0001", NOW, theme, width);
			for (const line of lines) expect(strip(line).length).toBeLessThanOrEqual(width);
			expect(lines.map(strip)).toContain(" │   ↳ shell: yarn vitest run");
			expect(owners).toEqual([undefined, "sneaky-dolphin", "sneaky-dolphin", "wily-kelp"]);
		}
	});
});

describe("activityText", () => {
	it("drops a leading cd and the checkout and home prefixes", () => {
		expect(activityText("shell: cd /a/repo && yarn test", [])).toBe("shell: yarn test");
		expect(activityText("cd '/a/my repo'; ls", [])).toBe("ls");
		expect(activityText("shell: cat /a/repo/src/x.ts", ["/a/repo"])).toBe("shell: cat src/x.ts");
		expect(activityText("read /home/me/notes.md", [], "/home/me")).toBe("read ~/notes.md");
		expect(activityText("shell: yarn test", ["/a/repo"])).toBe("shell: yarn test");
		expect(activityText(undefined, [])).toBe("");
	});
});
