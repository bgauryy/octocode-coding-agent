import { visibleWidth } from "@octocodeai/octocode-tui";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { beforeAll, describe, expect, it } from "vitest";
import { widgetLines } from "../../src/octocode/team/panel.ts";
import { teamTotalsText } from "../../src/octocode/team/panel/rows.ts";
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
const squash = (line: string | undefined) => line!.replace(/ +/g, " ");
const rowOf = (lines: string[], id: string) => lines.find((line) => line.includes(id))!;
/** The agent's name line and the stats line under it, joined: from 60 columns each agent takes two lines. */
const groupOf = (lines: string[], id: string) => {
	const at = lines.findIndex((line) => line.includes(id));
	return `${lines[at]}\n${lines[at + 1]}`;
};

describe("agents panel rows", () => {
	beforeAll(() => initTheme("dark"));

	it("roots the tree at this session: its name and role, then the team's state, tokens and cost", () => {
		const lines = widgetLines(team, "tidal-whale", NOW, theme, 200);
		expect(squash(lines[0])).toBe(" 🦑 tidal-whale claude-sonnet-4-5 2 working · 1 idle · 527k tok · ≈$1.23");
		expect(lines.join("\n")).not.toMatch(/^ agents/m);
	});

	it("shows who, what for, doing now and communication on line 1; model, state, time and tokens with the cached share on line 2", () => {
		const lines = widgetLines(team, "tidal-whale", NOW, theme, 200);
		expect(squash(lines[1])).toBe(
			" ├ ⠋ 🐙 inky-kraken researcher Checking vision routing refusal › localSearch vision_route",
		);
		expect(squash(lines[2])).toBe(" │ claude-sonnet-4-5 working 4m49s 166k tok 74% cached 14 tool calls ≈$0.41");
		expect(squash(lines[3])).toBe(
			" ├ ⠋ 🐙 plucky-otter researcher Checking timeout handling in serve_client.rs › localFetch serve_client.rs ✉ 1",
		);
		expect(squash(lines[4])).toBe(" │ claude-sonnet-4-5 working 4m49s 194k tok 63% cached 14 tool calls ≈$0.41");
		expect(squash(lines[5])).toBe(" └ ○ 🐙 brave-squid general Searching ContextMode and AdaptiveMode enums 1 lock");
		expect(squash(lines[6])).toBe(" claude-sonnet-4-5 idle 4m49s 166k tok 74% cached 3 tool calls ≈$0.41");
		expect(lines.join("\n")).not.toContain("anthropic/");
	});

	it("starts line 2 under the name: the tree line continues beside it, blank under the last agent", () => {
		const lines = widgetLines(team, "tidal-whale", NOW, theme, 200);
		const nameColumn = (id: string) => visibleWidth(rowOf(lines, id).slice(0, rowOf(lines, id).indexOf(id)));
		const stats = (id: string) => lines[lines.findIndex((line) => line.includes(id)) + 1];
		for (const id of ["inky-kraken", "plucky-otter", "brave-squid"])
			expect(visibleWidth(stats(id).slice(0, stats(id).search(/claude-sonnet/)))).toBe(nameColumn(id));
		expect(stats("inky-kraken")).toMatch(/^ │ +claude-sonnet/);
		expect(stats("plucky-otter")).toMatch(/^ │ +claude-sonnet/);
		expect(stats("brave-squid")).toMatch(/^ {3,}claude-sonnet/);
		expect(stats("brave-squid")).not.toContain("│");
	});

	it("keeps tokens, model, state, time and messages from 60 to 120 columns; cost, tools, cache and the goal give way first", () => {
		for (const width of [60, 70, 80, 90, 120]) {
			const lines = widgetLines(team, "tidal-whale", NOW, theme, width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			for (const id of ["inky-kraken", "plucky-otter", "brave-squid"]) {
				const group = groupOf(lines, id);
				for (const kept of ["claude-sonnet-4-5", "4m49s", "k tok"]) expect(group).toContain(kept);
				expect(group).toMatch(/working|idle/);
			}
			expect(groupOf(lines, "plucky-otter")).toContain("✉ 1");
			expect(groupOf(lines, "brave-squid")).toContain("1 lock");
		}
		const at = (width: number, id: string) => groupOf(widgetLines(team, "tidal-whale", NOW, theme, width), id);
		// Wide: everything. Then the cost goes, then the tool counts, then the cached share.
		expect(at(120, "inky-kraken")).toMatch(/74% cached.*14 tool calls.*≈\$0\.41/s);
		expect(at(90, "inky-kraken")).toContain("≈$0.41");
		expect(at(80, "inky-kraken")).not.toContain("≈$0.41");
		expect(at(80, "inky-kraken")).toContain("14 tool calls");
		expect(at(70, "inky-kraken")).not.toContain("tool calls");
		expect(at(70, "inky-kraken")).toContain("74% cached");
		// The role and the goal are cut before the tokens.
		expect(at(120, "inky-kraken")).toContain("researcher");
		expect(at(70, "plucky-otter")).toMatch(/Checking ti…/);
	});

	it("lines up model, state and token columns down the list", () => {
		for (const width of [120, 200]) {
			const lines = widgetLines(team, "tidal-whale", NOW, theme, width);
			const rows = ["inky-kraken", "plucky-otter", "brave-squid"].map((id) => groupOf(lines, id).split("\n")[1]);
			const start = (needle: RegExp) => new Set(rows.map((row) => row.search(needle)));
			expect(start(/claude-sonnet/).size).toBe(1);
			expect(start(/working|idle/).size).toBe(1);
			const tokensEnd = rows.map((row) => {
				const hit = /\d+k tok/.exec(row)!;
				return hit.index + hit[0].length;
			});
			expect(new Set(tokensEnd).size).toBe(1);
		}
	});

	it("draws the tree: ├ for a child with later siblings, └ for the last, │ continuing beside a grandchild", () => {
		const nested = [...team, agent("zesty-eel", "general", { parentId: "inky-kraken", goal: "Read routing.rs" })];
		const lines = widgetLines(nested, "tidal-whale", NOW, theme, 200);
		expect(rowOf(lines, "inky-kraken")).toMatch(/^ ├ ⠋ 🐙 inky-kraken/);
		expect(rowOf(lines, "zesty-eel")).toMatch(/^ │ └ ⠋ 🐙 zesty-eel/);
		expect(rowOf(lines, "brave-squid")).toMatch(/^ └ ○ 🐙 brave-squid/);
	});

	it("paints with meaning: the waiting message in the attention colour, the state word in its state colour", () => {
		const lines = widgetLines(team, "tidal-whale", NOW, liveTheme, 200);
		expect(rowOf(lines, "plucky-otter")).toContain(liveTheme.fg("warning", "✉ 1"));
		expect(groupOf(lines, "brave-squid")).toContain(liveTheme.fg("dim", "idle"));
		expect(groupOf(lines, "inky-kraken")).toContain(liveTheme.fg("accent", "working"));
	});
});

describe("team totals text", () => {
	const usage = (extra: Partial<Member>): Member => agent("x-0001", "general", { ...extra });

	it("sums tokens and cost over the session and its agents, with the cached share of the prompt", () => {
		const text = teamTotalsText([
			usage({ input: 10_000_000, cacheRead: 9_000_000, output: 200_000, cost: 1.5 }),
			usage({ input: 2_000_000, cacheRead: 1_500_000, output: 100_000, cost: 0.5 }),
		]);
		// 12.3M tokens in all; 10.5M of the 12M prompt tokens were cache reads (87.5%, rounded).
		expect(text).toMatch(/^Σ 2 agents · 12\.3M tok · \d+% cached · ≈\$2\.00$/);
		expect(text).toContain("88% cached");
	});

	it("marks cost n/a for a model without pricing, and leaves out the cache share without cache reads", () => {
		const text = teamTotalsText([
			usage({ input: 4_000, cacheRead: 0, output: 500, cost: 0.1 }),
			usage({ input: 1_000, cacheRead: 0, output: 100, cost: 0, unpriced: true }),
		]);
		expect(text).toContain("Σ 2 agents · 5.6k tok");
		expect(text).not.toContain("cached");
		expect(text).toContain("n/a");
	});
});
