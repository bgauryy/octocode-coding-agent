import { visibleWidth } from "@octocodeai/octocode-tui";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { beforeAll, describe, expect, it } from "vitest";
import { openWidgetLines as widgetLines } from "./two-line-panel.ts";
import { initTheme, theme as liveTheme } from "../../src/theme/theme.ts";
import { theme } from "./fake-host.ts";

const NOW = 1_000_000_000;
const agent = (id: string, role: string, extra: Partial<Member> = {}): Member => ({
	id,
	role,
	pid: process.pid,
	status: "working",
	parentId: "tidal-whale",
	joinedAt: NOW - 289_000,
	updatedAt: NOW,
	toolCalls: 14,
	input: 161_900,
	cacheRead: 120_000,
	output: 4_200,
	cost: 0.41,
	unpriced: false,
	model: "anthropic/claude-sonnet-4-5",
	...extra,
});
const team: Member[] = [
	agent("tidal-whale", "main", {
		parentId: undefined,
		status: "idle",
		toolCalls: 0,
		input: 0,
		cacheRead: 0,
		output: 0,
		cost: 0,
	}),
	agent("inky-kraken", "researcher", { goal: "Checking vision routing refusal", activity: "localSearch vision_route" }),
	agent("plucky-otter", "researcher", {
		goal: "Checking timeout handling in serve_client.rs",
		activity: "localFetch serve_client.rs",
		input: 190_200,
		pending: 1,
	}),
	agent("brave-squid", "general", {
		goal: "Searching ContextMode and AdaptiveMode enums",
		status: "idle",
		toolCalls: 3,
		locks: ["src/mode.rs"],
	}),
];
const rowOf = (lines: string[], id: string) => lines.find((line) => line.includes(id))!;
/** The detail line under an agent's row: open rows show it right below. */
const detailOf = (lines: string[], id: string) => lines[lines.findIndex((line) => line.includes(id)) + 1];
const separators = (line: string) => {
	const cells: number[] = [];
	for (let at = line.indexOf(" · "); at >= 0; at = line.indexOf(" · ", at + 1))
		cells.push(visibleWidth(line.slice(0, at)));
	return cells;
};

describe("agents panel rows", () => {
	beforeAll(() => initTheme("dark"));

	it("roots the tree at this session: name, mark, role and clock in the grid's columns, with no cost and no tally", () => {
		const lines = widgetLines(team, "tidal-whale", NOW, theme, 200);
		expect(lines[0]).toBe(
			" 🦑 tidal-whale ⏺ · main                                                                                                                                                                           4m49s",
		);
		expect(lines.join("\n")).not.toMatch(/working|idle|≈\$0\.00/);
	});

	it("shows who, role, spend, goal and action on the row; model, tokens, cache, tools and locks on the open detail line", () => {
		const lines = widgetLines(team, "tidal-whale", NOW, theme, 200);
		expect(rowOf(lines, "inky-kraken")).toBe(
			" ├ ⏺ inky-kraken  · researcher · Checking vision routing refusal                  › localSearch vision_route                                                         46.1k tok 74% cached · ≈$0.41 4m49s",
		);
		expect(rowOf(lines, "plucky-otter")).toContain(
			"Checking timeout handling in serve_client.rs ✉ 1 › localFetch serve_client.rs",
		);
		expect(detailOf(lines, "inky-kraken")).toBe(
			" │   claude-sonnet-4-5                                                                                                                                            46.1k tok · 74% cached · 14 tool calls",
		);
		expect(detailOf(lines, "brave-squid")).toBe(
			"     claude-sonnet-4-5                                                                                                                                    46.1k tok · 74% cached · 3 tool calls · 1 lock",
		);
		expect(lines.join("\n")).not.toContain("anthropic/");
	});

	it("starts the detail line under the name: the tree line continues beside it, blank under the last agent", () => {
		const lines = widgetLines(team, "tidal-whale", NOW, theme, 120);
		expect(detailOf(lines, "inky-kraken")).toMatch(/^ │ {3}claude-sonnet/);
		expect(detailOf(lines, "brave-squid")).toMatch(/^ {5}claude-sonnet/);
	});

	it("keeps name, role, goal and messages from 60 to 120 columns; the action moves below, then elapsed and cost give way", () => {
		for (const width of [60, 70, 80, 90, 120]) {
			const lines = widgetLines(team, "tidal-whale", NOW, theme, width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			for (const id of ["inky-kraken", "plucky-otter", "brave-squid"])
				expect(rowOf(lines, id)).toMatch(/· (researc|general)/);
			expect(rowOf(lines, "plucky-otter")).toContain("✉ 1");
			expect(lines.join("\n")).toContain("localFetch serve_client.rs");
		}
		const at = (width: number) => widgetLines(team, "tidal-whale", NOW, theme, width);
		expect(rowOf(at(120), "inky-kraken")).toContain("› localSearch vision_route");
		// It moves to a ↳ line under the goal column, which keeps room for it.
		expect(at(80).some((line) => /^ │ +↳ localSearch vision_route$/.test(line))).toBe(true);
		expect(rowOf(at(80), "inky-kraken")).toContain("≈$0.41 4m49s");
		expect(rowOf(at(60), "inky-kraken")).not.toMatch(/4m49s|≈\$/);
		expect(rowOf(at(60), "inky-kraken")).toContain("researc…");
	});

	it("lines up every column down the list", () => {
		for (const width of [80, 120, 200]) {
			const rows = widgetLines(team, "tidal-whale", NOW, theme, width).filter((line) => /^ (🦑|[├└])/.test(line));
			// This session's row has no goal, so it ends after its clock; its columns still match.
			const columns = separators(rows[1]).slice(0, 3);
			for (const row of rows) expect(separators(row).slice(0, 3)).toEqual(columns.slice(0, separators(row).length));
		}
	});

	it("draws the tree: ├ for a child with later siblings, └ for the last, │ continuing beside a grandchild", () => {
		const nested = [...team, agent("zesty-eel", "general", { parentId: "inky-kraken", goal: "Read routing.rs" })];
		const lines = widgetLines(nested, "tidal-whale", NOW, theme, 200);
		expect(rowOf(lines, "inky-kraken")).toMatch(/^ ├ ⏺ inky-kraken/);
		expect(rowOf(lines, "zesty-eel")).toMatch(/^ │ └ ⏺ zesty-eel/);
		expect(rowOf(lines, "brave-squid")).toMatch(/^ └ ⏺ brave-squid/);
		expect(lines.join("\n")).not.toContain("🐙");
	});

	it("paints with meaning: the waiting message in the attention colour, an idle name muted, a working one in text", () => {
		const lines = widgetLines(team, "tidal-whale", NOW, liveTheme, 200);
		expect(rowOf(lines, "plucky-otter")).toContain(liveTheme.fg("warning", "✉ 1"));
		expect(rowOf(lines, "brave-squid")).toContain(liveTheme.fg("muted", "brave-squid"));
		expect(rowOf(lines, "inky-kraken")).toContain(liveTheme.fg("text", "inky-kraken"));
	});
});

describe("token count of a row", () => {
	it("counts new prompt tokens and output, leaving cache reads to the cached share", () => {
		const lines = widgetLines(
			[team[0], agent("x-0001", "general", { input: 10_000_000, cacheRead: 9_000_000, output: 200_000 })],
			"tidal-whale",
			NOW,
			theme,
			200,
		);
		// 1M new prompt tokens + 200k output; 9M of the 10M prompt tokens were cache reads.
		expect(detailOf(lines, "x-0001")).toContain("1.2M tok · 90% cached · ");
	});
});
