import { animationClock, visibleWidth } from "@octocodeai/octocode-tui";
import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Finished } from "../../src/octocode/team/panel/compact.ts";
import { widgetLines, widgetRows } from "../../src/octocode/team/panel/layout.ts";
import { theme } from "./fake-host.ts";

// Reduced motion draws a running light as a full ⏺: an animation or a state, never a half-filled circle held still.
beforeEach(() => animationClock.setReducedMotion(true));
afterEach(() => animationClock.setReducedMotion(false));

const NOW = 1_000_000_000;
const ME = "jolly-seahorse";
const REPO = "/repo";
const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "general",
	pid: process.pid,
	parentId: ME,
	status: "working",
	joinedAt: NOW - 1_110_000,
	updatedAt: NOW,
	toolCalls: 12,
	input: 922_000,
	cacheRead: 866_000,
	output: 10_000,
	cost: 1.12,
	unpriced: false,
	checkout: REPO,
	cwd: REPO,
	...extra,
});

/** panel.md §4: main, three subagents (one waits for approval, one works and sent a message, one is done), two peers. */
const main = member(ME, {
	role: "main",
	parentId: undefined,
	model: "anthropic/claude-opus-4-5:high",
	goal: "TUI redesign RFC",
	activity: "agent: spawn researcher",
	cost: 3.29,
});
const squid = member("cheeky-squid", {
	role: "researcher",
	model: "anthropic/claude-sonnet-4-5:medium",
	goal: "Panel row audit",
	joinedAt: NOW - 300_000,
	cost: 0.31,
	waiting: "approval",
});
const mantle = member("snappy-mantle", {
	role: "implementer",
	model: "anthropic/claude-opus-4-5:high",
	goal: "B657+B658: remove extension surface and llama.cpp leftovers",
	activity: "shell: ls .octocode/tmp/dd-myfile-with-a-long-name/output",
});
const otter = member("brave-otter", {
	model: "anthropic/claude-haiku-4-5:low",
	goal: "Count footer parts",
	status: "idle",
	joinedAt: NOW - 1_105_000,
	cost: 0.02,
});
const peer = (id: string, extra: Partial<Member>) =>
	member(id, { role: "main", parentId: undefined, status: "idle", ...extra });
const peers = [
	peer("other-peer", {
		model: "anthropic/claude-opus-4-5:high",
		goal: "peer session A",
		status: "working",
		joinedAt: NOW - 2_462_000,
		cost: 5.1,
	}),
	peer("second-peer", {
		model: "anthropic/claude-opus-4-5:medium",
		goal: "peer session B",
		joinedAt: NOW - 190_000,
		cost: 0.4,
	}),
];
const message: Traffic = {
	id: 850,
	replyTo: 848,
	from: "snappy-mantle",
	to: ["other-peer"],
	text: "Do you still hold src/octocode/team/panel/rows.ts? I need to change the grid helpers and the tree prefix; reply with a time or release it.",
	at: NOW - 12_000,
	state: "awaiting reply",
};
const finished: Finished[] = [
	{
		member: otter,
		at: NOW - 5_000,
		end: { outcome: "done", headline: "Footer has 14 parts; 3 duplicate token counts" },
	},
];
const scene = (width: number, rows?: number, expanded?: "all") =>
	widgetLines([main, squid, mantle, ...peers], ME, NOW, theme, width, [message], rows, finished, [], true, expanded);

/** Where each ` · ` starts on a line, in terminal cells. */
const separators = (line: string) => {
	const cells: number[] = [];
	for (let at = line.indexOf(" · "); at >= 0; at = line.indexOf(" · ", at + 1))
		cells.push(visibleWidth(line.slice(0, at)));
	return cells;
};
/** The grid rows: this session's, each agent's and each peer's. */
const heads = (lines: string[]) => lines.filter((line) => /^ (🦑|[├└│ ]*[├└] )/.test(line));

const AT_80 = [
	" 🦑 jolly-seahorse ⏺ · TUI redesign RFC            › agent: spawn researcher",
	" ├ ⏺ snappy-mantle   · B657+B658: remove extensio…",
	// A cut by the terminal's edge resets the style around its ellipsis.
	" │   ↳ shell: ls .octocode/tmp/dd-myfile-with-a-long-name/output",
	" │   ✉ #850 ↩#848 → other-peer · awaiting reply · 12s ago",
	' │     "Do you still hold src/octocode/team/panel/rows.ts? I need to change',
	' │      the grid helpers and the tree prefix; reply with a time or release it."',
	" ├ ◉ brave-otter     · Count footer parts",
	" │   ↳ Footer has 14 parts; 3 duplicate token counts",
	" └ ◐ cheeky-squid    · Panel row audit",
	"     ↳ waits for your approval",
	"   peers",
	" 🦑 other-peer ⏺     · peer session A",
	" 🦑 second-peer ○    · peer session B",
];
const AT_120 = [
	" 🦑 jolly-seahorse ⏺ · TUI redesign RFC                                            › agent: spawn researcher",
	" ├ ⏺ snappy-mantle   · B657+B658: remove extension surface and llama.cpp leftovers",
	" │                     ↳ shell: ls .octocode/tmp/dd-myfile-with-a-long-name/output",
	" │   ✉ #850 ↩#848 → other-peer · awaiting reply · 12s ago",
	' │     "Do you still hold src/octocode/team/panel/rows.ts? I need to change the grid helpers and',
	' │      the tree prefix; reply with a time or release it."',
	" ├ ◉ brave-otter     · Count footer parts",
	" │   ↳ Footer has 14 parts; 3 duplicate token counts",
	" └ ◐ cheeky-squid    · Panel row audit",
	"     ↳ waits for your approval",
	"   peers",
	" 🦑 other-peer ⏺     · peer session A",
	" 🦑 second-peer ○    · peer session B",
];
/** Each agent's detail line (role and model, then time, cost and usage at the edge), shown under its row when open. */
const DETAILS_80 = {
	"snappy-mantle": " │   implementer · claude-opus-4-5:high   18m30s · ≈$1.12 · 66k tok · 94% cached",
	"brave-otter": " │   general · claude-haiku-4-5:low       18m20s · ≈$0.02 · 66k tok · 94% cached",
	"cheeky-squid": "     researcher · claude-sonnet-4-5:medium    5m · ≈$0.31 · 66k tok · 94% cached",
};
const DETAILS_120 = {
	"snappy-mantle": ` │   implementer · claude-opus-4-5:high${" ".repeat(27)}18m30s · ≈$1.12 · 66k tok · 94% cached · 12 tool calls`,
	"brave-otter": ` │   general · claude-haiku-4-5:low${" ".repeat(31)}18m20s · ≈$0.02 · 66k tok · 94% cached · 12 tool calls`,
	"cheeky-squid": `     researcher · claude-sonnet-4-5:medium${" ".repeat(28)}5m · ≈$0.31 · 66k tok · 94% cached · 12 tool calls`,
};
/** `mockup` with every agent's detail line open: each goes right under its agent's grid row. */
const opened = (mockup: string[], details: Record<string, string>) =>
	mockup.flatMap((line) => {
		const id = Object.keys(details).find((each) => line.includes(` ${each} `));
		return id ? [line, details[id]] : [line];
	});

describe("agents panel grid (panel.md §4 mockups)", () => {
	it("reproduces the 80-column mockup: an action too long for its row and the reasons on ↳ lines, role, time and cost on the open detail line", () => {
		expect(scene(80)).toEqual(AT_80);
		expect(scene(80, undefined, "all")).toEqual(opened(AT_80, DETAILS_80));
	});

	it("reproduces the 120-column mockup: an action inline when it fits whole, else under the goal column", () => {
		expect(scene(120)).toEqual(AT_120);
		expect(scene(120, undefined, "all")).toEqual(opened(AT_120, DETAILS_120));
	});

	it("reproduces the 200-column mockup: the action stays inline, time, cost, tokens and the cached share at the edge of the open detail line", () => {
		const lines = scene(200);
		expect(lines[0]).toBe(` 🦑 jolly-seahorse ⏺ · TUI redesign RFC${" ".repeat(44)}› agent: spawn researcher`);
		expect(lines[1]).toBe(
			" ├ ⏺ snappy-mantle   · B657+B658: remove extension surface and llama.cpp leftovers › shell: ls .octocode/tmp/dd-myfile-with-a-long-name/output",
		);
		expect(lines.join("\n")).not.toContain("↳ shell:");
		const open = scene(200, undefined, "all");
		expect(open[0]).toBe(lines[0]);
		expect(open[1]).toBe(lines[1]);
		expect(open[2]).toBe(
			` │   implementer · claude-opus-4-5:high${" ".repeat(107)}18m30s · ≈$1.12 · 66k tok · 94% cached · 12 tool calls`,
		);
	});

	it("starts every grid column at the same cell on every row, and draws no 🐙", () => {
		for (const width of [80, 120, 200]) {
			const lines = scene(width);
			const rows = heads(lines);
			expect(rows).toHaveLength(6);
			// One separator a row, before the goal column.
			expect(new Set(rows.map((line) => separators(line).join(","))).size, `width ${width}`).toBe(1);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(lines.join("\n")).not.toContain("🐙");
		}
	});

	it("caps a message block at three lines and 100 columns, ending a longer body in …", () => {
		const long = { ...message, text: `${"word ".repeat(80)}end` };
		const lines = widgetLines([main, mantle], ME, NOW, theme, 200, [long]);
		const at = lines.findIndex((line) => line.includes("✉ #850"));
		const block = lines.slice(at);
		expect(block).toHaveLength(3);
		for (const line of block) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		expect(block[2].replace(/\x1b\[[0-9;]*m/g, "")).toMatch(/…"$/);
	});

	it("shows up to two peers of this checkout, and none from another worktree", () => {
		const third = peer("third-peer", { goal: "peer session C", joinedAt: NOW - 100_000 });
		const elsewhere = peer("far-peer", { checkout: "/other-worktree" });
		const lines = widgetLines([main, squid, ...peers, third, elsewhere], ME, NOW, theme, 120, [], 60);
		expect(lines.filter((line) => line.startsWith(" 🦑")).length).toBe(3);
		expect(lines).toContain("   peers +1");
		expect(lines.join("\n")).not.toContain("far-peer");
	});
});

describe("agents panel row budget", () => {
	const crowd = Array.from({ length: 8 }, (_, index) =>
		member(`agent-${index}`, {
			goal: `Task ${index}`,
			activity: "shell: a command too long to sit beside the goal column at all",
		}),
	);
	const notes = crowd.map((agent, index): Traffic => ({ ...message, id: 900 + index, from: agent.id }));

	it("fits a 15-row budget: the agent that needs you keeps its row and reason, the rest collapse to +N more", () => {
		const waiting = { ...crowd[7], waiting: "approval" as const };
		const lines = widgetLines([main, ...crowd.slice(0, 7), waiting, ...peers], ME, NOW, theme, 120, notes, 45);
		expect(lines.length).toBeLessThanOrEqual(15);
		// The urgent agent keeps a row, in start order: the kept rows are the first ones that fit, plus it.
		const at = lines.findIndex((line) => line.includes("agent-7"));
		expect(at).toBeGreaterThan(0);
		expect(lines[at + 1]).toContain("↳ waits for your approval");
		expect(lines.findIndex((line) => line.includes("agent-0"))).toBeLessThan(at);
		expect(lines.at(-2)).toMatch(/^ \+\d more · ⏺ \d$/);
		// Peers keep one row naming them all.
		expect(lines.at(-1)).toBe(" 🦑 2 peers · other-peer ⏺ second-peer ○");
		// Every agent row still carries the tree.
		for (const line of lines.slice(1, -1)) if (line.includes("agent-")) expect(line).toMatch(/^ [│ ]*[├└] /);
	});

	it("never takes more than 16 rows, however tall the terminal or when its height is unknown", () => {
		for (const rows of [undefined, 60, 200]) {
			const lines = widgetLines([main, ...crowd, ...peers], ME, NOW, theme, 120, notes, rows);
			expect(lines.length, `rows ${rows}`).toBeLessThanOrEqual(16);
		}
	});

	it("maps continuation and message lines to their agent for a click", () => {
		const { lines, owners } = widgetRows([main, mantle], ME, NOW, theme, 120, [message]);
		expect(owners[0]).toBeUndefined();
		expect(lines.slice(1).every((_, index) => owners[index + 1] === "snappy-mantle")).toBe(true);
	});
});

describe("agents panel role cell and message age", () => {
	const rowOf = (lines: string[], id: string) => lines.find((line) => line.includes(id));
	/** The detail line under an agent's row: open rows show it right below. */
	const detailOf = (lines: string[], id: string) => lines[lines.findIndex((line) => line.includes(id)) + 1];
	const open = (members: Member[]) => widgetLines(members, ME, NOW, theme, 120, [], undefined, [], [], true, "all");
	const SPEND = "18m30s · ≈$1.12 · 66k tok · 94% cached · 12 tool calls";

	it("shows `role:?` for a runner child, whose effort its own process owns, also beside the model it reports", () => {
		const runner = member("codex-9a1b", { role: "implementer", mailbox: "pull" });
		const lines = open([main, runner]);
		expect(rowOf(lines, "codex-9a1b")).toBe(" └ ⏺ codex-9a1b");
		expect(detailOf(lines, "codex-9a1b")).toBe(`     implementer:?${" ".repeat(48)}${SPEND}`);
		// The level its model carries is not the effort the runner works at: the `?` stays.
		const reported = open([main, { ...runner, model: "openai/gpt-5:high" }]);
		expect(detailOf(reported, "codex-9a1b")).toBe(`     implementer:? · gpt-5:high${" ".repeat(35)}${SPEND}`);
	});

	it("shows the role for an id that starts with it", () => {
		const named = member("researcher-3fa9", { role: "researcher", model: "anthropic/claude-sonnet-4-5:medium" });
		const bare = member("general-77aa", { role: "general" });
		const lines = open([main, named, bare]);
		expect(rowOf(lines, "researcher-3fa9")).toBe(" ├ ⏺ researcher-3fa9");
		expect(detailOf(lines, "researcher-3fa9")).toBe(
			` │   researcher · claude-sonnet-4-5:medium${" ".repeat(24)}${SPEND}`,
		);
		expect(rowOf(lines, "general-77aa")).toBe(" └ ⏺ general-77aa");
		expect(detailOf(lines, "general-77aa")).toBe(`     general${" ".repeat(54)}${SPEND}`);
	});

	it("reads a message's age from its own timestamp", () => {
		const old = { ...message, at: NOW - 5 * 60_000 - 20_000 };
		const lines = widgetLines([main, mantle], ME, NOW, theme, 120, [old]);
		expect(lines).toContain("     ✉ #850 ↩#848 → other-peer · awaiting reply · 5m ago");
	});
});
