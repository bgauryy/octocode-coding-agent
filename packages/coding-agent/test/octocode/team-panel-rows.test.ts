import { visibleWidth } from "@octocodeai/octocode-tui";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { beforeAll, describe, expect, it } from "vitest";
import { widgetLines } from "../../src/octocode/team/panel.ts";
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

describe("agents panel rows", () => {
	beforeAll(() => initTheme("dark"));

	it("roots the tree at this session: its name and role, then the team's state, tokens and cost", () => {
		const lines = widgetLines(team, "tidal-whale", NOW, theme, 200);
		expect(squash(lines[0])).toBe(" ● tidal-whale main 2 working · 1 idle · 527k tok · ≈$1.23");
		expect(lines.join("\n")).not.toMatch(/^ agents/m);
	});

	it("shows who, what for, doing now, communication, model, state, time and tokens with the cached share", () => {
		const lines = widgetLines(team, "tidal-whale", NOW, theme, 200);
		expect(squash(lines[1])).toBe(
			" ├ ⠋ inky-kraken researcher Checking vision routing refusal › localSearch vision_route claude-sonnet-4-5 working 4m49s 166k tok 74% cached 14 tool calls ≈$0.41",
		);
		expect(squash(lines[2])).toBe(
			" ├ ⠋ plucky-otter researcher Checking timeout handling in serve_client.rs › localFetch serve_client.rs ✉ 1 claude-sonnet-4-5 working 4m49s 194k tok 63% cached 14 tool calls ≈$0.41",
		);
		expect(squash(lines[3])).toBe(
			" └ ○ brave-squid general Searching ContextMode and AdaptiveMode enums 1 lock claude-sonnet-4-5 idle 4m49s 166k tok 74% cached 3 tool calls ≈$0.41",
		);
		expect(lines.join("\n")).not.toContain("anthropic/");
	});

	it("keeps tokens, model, state, time and messages at 90 and 120 columns; per-agent cost, cache, role and goal give way first", () => {
		for (const width of [90, 120]) {
			const lines = widgetLines(team, "tidal-whale", NOW, theme, width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			for (const id of ["inky-kraken", "plucky-otter", "brave-squid"]) {
				const row = rowOf(lines, id);
				for (const kept of ["claude-sonnet-4-5", "4m49s", "k tok"]) expect(row).toContain(kept);
				expect(row).toMatch(/working|idle/);
				expect(row).not.toContain("tool calls");
			}
			expect(rowOf(lines, "plucky-otter")).toContain("✉ 1");
			expect(rowOf(lines, "brave-squid")).toContain("1 lock");
		}
		const medium = widgetLines(team, "tidal-whale", NOW, theme, 120);
		expect(rowOf(medium, "inky-kraken")).toContain("researcher");
		expect(rowOf(medium, "inky-kraken")).toContain("74% cached");
		const narrow = widgetLines(team, "tidal-whale", NOW, theme, 90);
		expect(rowOf(narrow, "plucky-otter")).toMatch(/Checking timeout[^ ]* ?[^ ]*…/);
		expect(rowOf(narrow, "inky-kraken")).not.toContain("cached");
	});

	it("lines up model, state and token columns down the list", () => {
		for (const width of [120, 200]) {
			const rows = widgetLines(team, "tidal-whale", NOW, theme, width).slice(1, 4);
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
		expect(rowOf(lines, "inky-kraken")).toMatch(/^ ├ ⠋ inky-kraken/);
		expect(rowOf(lines, "zesty-eel")).toMatch(/^ │ └ ⠋ zesty-eel/);
		expect(rowOf(lines, "brave-squid")).toMatch(/^ └ ○ brave-squid/);
	});

	it("paints with meaning: the waiting message in the attention colour, the state word in its state colour", () => {
		const lines = widgetLines(team, "tidal-whale", NOW, liveTheme, 200);
		expect(rowOf(lines, "plucky-otter")).toContain(liveTheme.fg("warning", "✉ 1"));
		expect(rowOf(lines, "brave-squid")).toContain(liveTheme.fg("dim", "idle"));
		expect(rowOf(lines, "inky-kraken")).toContain(liveTheme.fg("accent", "working"));
	});
});
