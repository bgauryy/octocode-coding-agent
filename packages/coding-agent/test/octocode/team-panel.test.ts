import fs from "node:fs";
import path from "node:path";
import { visibleWidth } from "@octocodeai/octocode-tui";
import { describe, expect, it } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { AgentsView, trafficRow, widgetLines } from "../../src/octocode/team/panel.ts";
import { collapsedRows, FINISHED_MS, shownWorking } from "../../src/octocode/team/panel/compact.ts";
import { FinishedTracker } from "../../src/octocode/team/panel/finished.ts";
import { describeMembers } from "../../src/octocode/team/member-list.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { fakeCtx, fakeHost, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const NOW = 1_000_000;
const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: id.replace(/-[0-9a-f]{4,6}$/, ""),
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

describe("agents panel", () => {
	it("shows a subagent that joined moments ago as working, without changing its stored status", () => {
		const fresh = member("general-1a2b", { parentId: "me-0001", joinedAt: NOW - 1_000 });
		expect(fresh.status).toBe("idle");
		expect(shownWorking(fresh, NOW)).toBe(true);
		// Later, or once it has worked, its stored status speaks again; a top-level session never gets the grace.
		expect(shownWorking({ ...fresh, joinedAt: NOW - 5_000 }, NOW)).toBe(false);
		expect(shownWorking({ ...fresh, toolCalls: 2 }, NOW)).toBe(false);
		expect(shownWorking(member("peer-1a2b", { joinedAt: NOW - 1_000 }), NOW)).toBe(false);
		const rows = widgetLines([member("me-0001"), fresh], "me-0001", NOW, theme, 120).join("\n");
		expect(rows).toContain("working");
		expect(rows).not.toContain("idle");
	});

	it("bounds six working agents by the terminal height and keeps their names distinct", () => {
		const agents = ["a1f3", "b2e4", "c3d5", "d4c6", "e5b7", "f6a8"].map((hash) =>
			member(`researcher-${hash}`, {
				parentId: "main",
				status: "working",
				goal: "Investigate the flaky tests ".repeat(4),
				model: "provider/a-very-long-model-name",
				activity: "reading files",
			}),
		);
		const terminalRows = 24;
		for (const width of [40, 80]) {
			const rows = widgetLines(agents, "main", NOW, theme, width, [], terminalRows);
			// Bound: a third of the terminal (8 of 24 rows): the header plus one row per agent fits.
			expect(rows.length).toBeLessThanOrEqual(Math.floor(terminalRows / 3));
			expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
			for (const agent of agents) expect(rows.filter((row) => row.includes(agent.id))).toHaveLength(1);
		}
	});

	it("reserves at least eight cells for a name beside a long state", () => {
		const rows = widgetLines(
			[member("researcher-a1f3", { parentId: "main", status: "working", pending: 12, locks: ["a", "b"] })],
			"main",
			NOW,
			theme,
			24,
		);
		expect(rows[1]).toMatch(/researc/);
		expect(rows.every((row) => visibleWidth(row) <= 24)).toBe(true);
	});

	it("keeps identity and state visible when a long goal and model cannot fit", () => {
		const rows = widgetLines(
			[
				member("research-a", {
					parentId: "main",
					status: "working",
					goal: "Investigate ".repeat(20),
					model: "provider/a-very-long-model-name",
				}),
			],
			"main",
			NOW,
			theme,
			48,
		);
		expect(rows[1]).toContain("research-a");
		expect(rows[1]).toContain("working");
		// One head row (tree, name, state, elapsed; the model only when it fits whole): the detail row gave way at this width.
		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatch(/^ └ ⠋ research-a · working · 1m$/);
		expect(rows.join("\n")).not.toMatch(/\b(age|model)\b/);
		expect(rows.every((row) => visibleWidth(row) <= 48)).toBe(true);
	});

	it("narrow layout: elapsed time follows the member's join time, and the detail row gives way to the state at 32 columns", () => {
		const agents = [member("research-a", { parentId: "main", goal: "Inspect ".repeat(20) })];
		const before = widgetLines(agents, "main", NOW, theme, 32);
		const after = widgetLines(agents, "main", NOW + 5_000, theme, 32);
		expect(before[1]).toBe(" └ ○ research-a · idle · 1m");
		expect(after[1]).toBe(" └ ○ research-a · idle · 1m05s");
		expect(before).toHaveLength(2);
	});

	it("narrow layout: the detail row shows the goal of an idle agent, and its activity while it works, from 64 columns", () => {
		const id = "researcher-with-a-really-long-name-0001";
		const idle = widgetLines([member(id, { parentId: "main", goal: "Inspect ".repeat(20) })], "main", NOW, theme, 60);
		expect(idle[2]).toMatch(/^ {5}Inspect Inspect/);
		const busy = member(id, {
			parentId: "main",
			status: "working",
			goal: "Inspect things",
			activity: "localFetch x.ts",
		});
		expect(widgetLines([busy], "main", NOW, theme, 60)[2]).toContain("Inspect things");
		expect(widgetLines([busy], "main", NOW, theme, 60)[2]).not.toContain("localFetch");
		expect(widgetLines([busy], "main", NOW, theme, 70)[2]).toContain("localFetch x.ts");
	});

	const team = [
		member("main-aaaaaa"),
		member("researcher-3fa9", {
			parentId: "main-aaaaaa",
			status: "working",
			joinedAt: NOW - 134_000,
			toolCalls: 12,
			input: 12_000,
			output: 3_000,
			cost: 0.04,
			goal: "Find where tools register",
			activity: "localSearch registerTool",
			model: "anthropic/claude-opus-4-5",
		}),
		member("reviewer-a1b2", {
			parentId: "main-aaaaaa",
			joinedAt: NOW - 45_000,
			toolCalls: 3,
			input: 4_000,
			output: 1_000,
			goal: "Review the diff",
			pending: 1,
			locks: ["src/a.ts"],
			model: "gpt-5",
		}),
		member("general-77aa", {
			parentId: "researcher-3fa9",
			status: "working",
			joinedAt: NOW - 5_000,
			toolCalls: 1,
			activity: "bash yarn test",
			model: "claude-haiku-4-5",
		}),
	];

	it("aligns the columns: every row puts model, state, time and tools at the same offsets", () => {
		const lines = widgetLines(team, "main-aaaaaa", NOW, theme, 160);
		const rows = lines.slice(1, 4);
		const at = (needle: RegExp) => rows.map((row) => row.search(needle));
		expect(new Set(at(/working|idle/)).size).toBe(1);
		expect(new Set(at(/claude-opus|claude-haiku|gpt-5/)).size).toBe(1);
		// Right-aligned: every tool count ends at the same offset.
		expect(
			new Set(
				rows.map((row) => {
					const hit = /\d+ tool calls?/.exec(row)!;
					return hit.index + hit[0].length;
				}),
			).size,
		).toBe(1);
		expect(rows.every((row) => visibleWidth(row) <= 160)).toBe(true);
	});

	it("roots the list at this session's totals, then model, state, age, tokens, tools and what each agent is doing now, working first", () => {
		const lines = widgetLines(team, "main-aaaaaa", NOW, theme, 200);
		const squash = (line: string | undefined) => line!.replace(/ +/g, " ");
		expect(squash(lines[0])).toBe(" ● main-aaaaaa main 2 working · 1 idle · 20k tok · ≈$0.04");
		expect(squash(lines[1])).toBe(
			" ├ ⠋ researcher-3fa9 Find where tools register › localSearch registerTool claude-opus-4-5 working 2m14s 15k tok 12 tool calls ≈$0.04",
		);
		// A grandchild sits under its parent with the tree line beside it; no goal or usage leaves those cells empty.
		expect(squash(lines[2])).toBe(" │ └ ⠋ general-77aa bash yarn test claude-haiku-4-5 working 5s 1 tool call");
		expect(squash(lines[3])).toBe(" └ ○ reviewer-a1b2 Review the diff ✉ 1 · 1 lock gpt-5 idle 45s 5k tok 3 tool calls");
		// A role the id already starts with (`researcher-3fa9`) is not repeated.
		expect(lines.slice(1).join("\n")).not.toMatch(/ (researcher|reviewer|general) /);
		// Provider prefixes stay out of the panel.
		expect(lines.join("\n")).not.toMatch(/anthropic\//);
	});

	it("drops per-agent cost and tools first, keeps tokens, and shortens the goal before the activity; then two lines", () => {
		const medium = widgetLines(team, "main-aaaaaa", NOW, theme, 120);
		expect(medium.every((line) => visibleWidth(line) <= 120)).toBe(true);
		expect(medium[1]).not.toContain("$0.04");
		expect(medium[1]).not.toContain("12 tool calls");
		for (const kept of ["claude-opus-4-5", "working", "2m14s", "15k tok", "› localSearch registerTool"])
			expect(medium[1]).toContain(kept);
		expect(medium[1]).toMatch(/Find where[^›]*… ›/);
		const narrow = widgetLines(team, "main-aaaaaa", NOW, theme, 90);
		expect(narrow.every((line) => visibleWidth(line) <= 90)).toBe(true);
		expect(narrow[1]).toBe(" ├ ⠋ researcher-3fa9 · working · 2m14s · 15k tok · claude-opus-4-5");
		expect(narrow[2]).toBe(" │   localSearch registerTool");
		expect(narrow.join("\n")).toContain("✉ 1 · 1 lock");
	});

	it("keeps a long activity readable at 120 columns by shortening the goal, not by dropping tokens or the cached share", () => {
		const busy = member("glowing-prawn", {
			parentId: "main-aaaaaa",
			status: "working",
			goal: "ask parent a color, sleep, report",
			model: "guy-provider/claude-haiku-5-5",
			joinedAt: NOW - 5_000,
			input: 275,
			cacheRead: 58_400,
			output: 135,
			activity: "Running shell: sleep 25",
		});
		const row = widgetLines([member("main-aaaaaa"), busy], "main-aaaaaa", NOW, theme, 120)[1];
		expect(row).toContain("› Running shell: sleep 25");
		expect(row).toMatch(/ask parent a[^›]*… ›/);
		expect(row).toContain("58.5k tok");
		expect(row).toContain("100% cached");
		// With room (200 columns) the whole goal shows too.
		expect(widgetLines([member("main-aaaaaa"), busy], "main-aaaaaa", NOW, theme, 200)[1]).toContain(
			"ask parent a color, sleep, report › Running shell: sleep 25",
		);
	});

	it("keeps a departed agent as a neutral row for FINISHED_MS, after the live ones", () => {
		const gone = member("sly-crab", { parentId: "main-aaaaaa", status: "working", joinedAt: NOW - 24_000 });
		const finished = [{ member: gone, at: NOW - 9_000 }];
		const main = member("main-aaaaaa");
		const live = member("wobbly-siphon", { parentId: "main-aaaaaa", status: "working" });
		// The last moment its row shows, and the next one; the live agents keep their heartbeat.
		const lastShown = NOW - 9_000 + FINISHED_MS;
		const beat = (at: number) => [
			{ ...main, updatedAt: at },
			{ ...live, updatedAt: at },
		];
		const lines = widgetLines([main, live], "main-aaaaaa", NOW, theme, 120, [], undefined, finished);
		expect(lines[0]).toBe(" ● main-aaaaaa  main  1 working · 1 left");
		expect(lines[1]).toContain("wobbly-siphon");
		expect(lines[2]).toMatch(/^ └ ○ sly-crab +left +15s/);
		expect(lines[2]).not.toContain("working");
		// The elapsed time stays the run's length while the row is shown (`FINISHED_MS` after it left, inclusive).
		const later = widgetLines(beat(lastShown), "main-aaaaaa", lastShown, theme, 120, [], undefined, finished);
		expect(later[2]).toMatch(/left +15s/);
		// Then the row is gone; a lone departed agent keeps the panel for that long only.
		expect(
			widgetLines(beat(lastShown + 1), "main-aaaaaa", lastShown + 1, theme, 120, [], undefined, finished),
		).toHaveLength(2);
		expect(widgetLines([main], "main-aaaaaa", NOW, theme, 120, [], undefined, finished)).toHaveLength(2);
		expect(widgetLines([main], "main-aaaaaa", lastShown + 1, theme, 120, [], undefined, finished)).toEqual([]);
		// Collapsed to one row per agent (few terminal rows) it still reads left.
		const [row] = collapsedRows([{ member: gone, depth: 0, doneAt: NOW - 9_000 }], NOW, theme, 120);
		expect(row).toBe(" ○ sly-crab · left · 15s");
	});

	it("does not claim a departed child succeeded when its outcome is unknown", () => {
		const main = member("main-aaaaaa");
		const child = member("reviewer-a1b2", { parentId: main.id, status: "working" });
		const tracker = new FinishedTracker();
		tracker.update(main.id, [main, child], [child], NOW);
		tracker.update(main.id, [main], [], NOW + 1_000);
		const lines = widgetLines([main], main.id, NOW + 1_000, theme, 120, [], undefined, tracker.finished);
		expect(lines.join("\n")).toContain("reviewer-a1b2");
		expect(lines.join("\n")).toContain("left");
		expect(lines.join("\n")).not.toContain("done");
	});

	it("shows every token with the cached share and marks a model without pricing in the row and the root row", () => {
		const priced = member("researcher-3fa9", {
			parentId: "main-aaaaaa",
			toolCalls: 2,
			input: 1_200_000,
			cacheRead: 1_128_000,
			output: 35_000,
			cost: 2.28,
		});
		const free = member("general-77aa", {
			parentId: "main-aaaaaa",
			toolCalls: 1,
			input: 4_000,
			output: 500,
			unpriced: true,
		});
		const lines = widgetLines([member("main-aaaaaa"), priced, free], "main-aaaaaa", NOW, theme, 200).map((line) =>
			line.replace(/ +/g, " "),
		);
		expect(lines[0]).toBe(" ● main-aaaaaa main 2 idle · 1.2M tok · ≈$2.28 + n/a");
		expect(lines[1]).toBe(" ├ ○ researcher-3fa9 idle 1m 1.2M tok 94% cached 2 tool calls ≈$2.28");
		expect(lines[2]).toBe(" └ ○ general-77aa idle 1m 4.5k tok 1 tool call cost n/a");
	});

	it('keeps every line within a narrow width, the "+N more" line too', () => {
		const many = [
			member("main-aaaaaa"),
			...Array.from({ length: 20 }, (_, i) =>
				member(`general-${String(i).padStart(6, "0")}`, { parentId: "main-aaaaaa" }),
			),
		];
		const lines = widgetLines(many, "main-aaaaaa", NOW, theme, 4);
		expect(lines.some((line) => line.includes("+"))).toBe(true);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(4);
	});

	it("hides agents whose heartbeat stopped (killed or hung) and shows nothing when none are left", () => {
		const stale = [
			member("main-aaaaaa"),
			member("general-dead", { parentId: "main-aaaaaa", status: "working", updatedAt: NOW - 20_000 }),
		];
		expect(widgetLines(stale, "main-aaaaaa", NOW, theme, 120)).toEqual([]);
		const mixed = widgetLines(
			[...stale, member("general-live", { parentId: "main-aaaaaa" })],
			"main-aaaaaa",
			NOW,
			theme,
			120,
		).join("\n");
		expect(mixed).toContain("general-live");
		expect(mixed).not.toContain("general-dead");
	});
});

/** A member whose heartbeat is current in wall-clock time (the store stamps real times). */
const live = (id: string, extra: Partial<Member> = {}): Member => member(id, { updatedAt: Date.now(), ...extra });
const repo = () => {
	const dir = tmp();
	fs.mkdirSync(path.join(dir, ".git"));
	return dir;
};
const open = (cwd: string, db: string) => TeamStore.open(cwd, db);
const sent = (result: { id: number | undefined }) => result.id!;

describe("agent model", () => {
	it("stores each agent's model and shows it in `coordinate list`", () => {
		const store = open(repo(), path.join(tmp(), "team.sqlite"));
		store.save(live("main-aaaaaa"));
		store.save(live("researcher-bbbbbb", { parentId: "main-aaaaaa", model: "claude-opus-4-5" }));
		const listed = store.list();
		expect(listed.find((agent) => agent.id === "researcher-bbbbbb")?.model).toBe("claude-opus-4-5");
		expect(listed.find((agent) => agent.id === "main-aaaaaa")?.model).toBeUndefined();
		expect(describeMembers(listed, "main-aaaaaa")).toContain(
			"researcher-bbbbbb · researcher · idle · claude-opus-4-5 · parent main-aaaaaa",
		);
	});
});

describe("panel traffic", () => {
	it("keeps delivery state visible ahead of long addresses on narrow terminals", () => {
		const row = trafficRow(
			{
				id: 1,
				from: "researcher-with-a-long-name",
				to: ["reviewer-with-a-long-name"],
				text: "Check this",
				at: NOW,
				state: "awaiting reply",
			},
			NOW,
			theme,
			48,
		);
		expect(row).toContain("awaiting reply");
		expect(visibleWidth(row)).toBeLessThanOrEqual(48);
	});

	it("keeps this session's subagent messages when other sessions are busier", () => {
		const store = open(repo(), path.join(tmp(), "team.sqlite"));
		store.save(live("main-aaaaaa"));
		store.save(live("researcher-bbbbbb", { parentId: "main-aaaaaa" }));
		store.save(live("tester-cccccc", { parentId: "main-aaaaaa" }));
		store.save(live("main-dddddd"));
		store.save(live("helper-eeeeee", { parentId: "main-dddddd" }));
		const mine = sent(store.send("researcher-bbbbbb", ["tester-cccccc"], "ours", { replyRequired: false }));
		for (let index = 0; index < 5; index += 1)
			store.send("main-dddddd", ["helper-eeeeee"], `theirs ${index}`, { replyRequired: false });
		const traffic = store.recent();
		expect(traffic.map((message) => message.id)).toContain(mine);
		const lines = widgetLines(
			[
				live("main-aaaaaa"),
				live("researcher-bbbbbb", { parentId: "main-aaaaaa" }),
				live("tester-cccccc", { parentId: "main-aaaaaa" }),
			],
			"main-aaaaaa",
			Date.now(),
			theme,
			200,
			traffic,
		);
		expect(lines.join("\n")).toContain(`#${mine}`);
		// The message sits on its sender's row, not in a block of its own.
		const at = lines.findIndex((line) => line.includes(`#${mine}`));
		expect(lines[at - 1]).toContain("researcher-bbbbbb");
		expect(lines.join("\n")).not.toContain("theirs");
	});

	it("shows one latest message per sender and cuts long rows with a single-character ellipsis", () => {
		const now = Date.now();
		const panel = [live("main-aaaaaa"), live("researcher-bbbbbb", { parentId: "main-aaaaaa", goal: "x".repeat(300) })];
		const traffic = [1, 2, 3, 4, 5].map((id) => ({
			id,
			from: "researcher-bbbbbb",
			to: ["tester-c"],
			text: "y".repeat(200),
			at: now,
			state: "delivered" as const,
		}));
		const lines = widgetLines(panel, "main-aaaaaa", now, theme, 60, traffic);
		expect(lines.filter((line) => line.includes("↳"))).toHaveLength(1);
		const cut = lines.filter((line) => line.includes("…"));
		expect(cut.length).toBeGreaterThan(0);
		expect(lines.join("\n")).not.toContain("...");
	});
});

describe("background subagents in the footer", () => {
	it("counts them while the panel shows no team rows (the team database is off or unused), and clears at none", () => {
		const f = fakeHost();
		const team = new Team(f.api, { OCTOCODE_AGENT_DB: path.join(tmp(), "none", "team.sqlite") });
		const ctx = fakeCtx({ cwd: tmp() });
		team.start(ctx);
		const view = new AgentsView(team);
		view.start(ctx);
		view.setBackground(["general-1a2b", "general-3c4d"]);
		expect(ctx.ui.statuses.get("octocode-running")).toBe("2 agents");
		view.setBackground([]);
		expect(ctx.ui.statuses.get("octocode-running")).toBeUndefined();
		view.setBackground(["general-1a2b"]);
		view.stop(ctx);
		expect(ctx.ui.statuses.get("octocode-running")).toBeUndefined();
		team.stop();
	});
});
