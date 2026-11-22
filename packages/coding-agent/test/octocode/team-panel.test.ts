import fs from "node:fs";
import path from "node:path";
import { animationClock, stripRowMarks, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { AgentsView, trafficRow } from "../../src/octocode/team/panel.ts";
import { openWidgetLines as widgetLines } from "./two-line-panel.ts";
import { FINISHED_MS, shownWorking } from "../../src/octocode/team/panel/compact.ts";
import { collapsedRows } from "../../src/octocode/team/panel/rows.ts";
import { FinishedTracker } from "../../src/octocode/team/panel/finished.ts";
import { describeMembers } from "../../src/octocode/team/member-list.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { fakeCtx, fakeHost, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const NOW = 1_000_000;
// Reduced motion pins a running light to its first frame, ◒.
beforeEach(() => animationClock.setReducedMotion(true));
afterEach(() => animationClock.setReducedMotion(false));
/** Lines without the style resets a cut (`…`) adds, for exact comparisons. */
/** A row as drawn: no colour, and no row marks (the renderer strips them before output). */
const plain = (lines: string[]) => lines.map((line) => stripRowMarks(line).replace(/\x1b\[[0-9;]*m/g, ""));
/** An agent's grid row and the line under it (its stats line when open and it has stats). */
const groupOf = (lines: string[], name: string): [string, string] => {
	const at = lines.findIndex((line) => line.includes(name));
	return [lines[at], lines[at + 1]];
};
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
		const rows = widgetLines([member("me-0001"), fresh], "me-0001", NOW, theme, 120);
		// The spinner says it works; the mark is the only state shown, never a word.
		expect(rows[1]).toBe(
			" └ ◒ general-1a2b · general                                                                                           1s",
		);
		expect(rows.join("\n")).not.toMatch(/working|idle/);
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
		// The narrow form: tree, mark and name; the cut goal under the name; the model, without its provider, on the stats line.
		expect(plain(rows)).toEqual([
			" 🦑 main ⏺ · main",
			" └ ◒ research-a · research-a",
			"     Investigate Investigate Investigate Invest…",
			"     a-very-long-model-name",
		]);
		expect(rows.join("\n")).not.toMatch(/\b(age|working)\b/);
		expect(rows.every((row) => visibleWidth(row) <= 48)).toBe(true);
	});

	it("elapsed time follows the member's join time; below 60 columns the narrow form leaves it for the goal line", () => {
		const agents = [member("research-a", { parentId: "main", goal: "Inspect ".repeat(20) })];
		expect(plain(widgetLines(agents, "main", NOW, theme, 80))[1]).toMatch(
			/^ └ ⏺ research-a · research-a · Inspect Inspect .*… +1m$/,
		);
		expect(widgetLines(agents, "main", NOW + 5_000, theme, 80)[1]).toMatch(
			/^ └ ⏺ research-a · research-a · Inspect .* +1m05s$/,
		);
		expect(plain(widgetLines(agents, "main", NOW, theme, 32))).toEqual([
			" 🦑 main ⏺ · main",
			" └ ⏺ research-a · research-a",
			"     Inspect Inspect Inspect In…",
		]);
	});

	it("narrow layout: below 60 columns the goal and the ↳ action take their own lines under the name", () => {
		const id = "researcher-with-a-really-long-name-0001";
		const idle = widgetLines([member(id, { parentId: "main", goal: "Inspect ".repeat(20) })], "main", NOW, theme, 56);
		expect(idle[1]).toBe(" └ ⏺ researcher-with-a-r… · researcher-…");
		expect(plain(idle)[2]).toMatch(/^ {5}Inspect Inspect .*…$/);
		expect(idle).toHaveLength(3);
		const busy = member(id, {
			parentId: "main",
			status: "working",
			goal: "Inspect things",
			activity: "localFetch x.ts",
		});
		for (const width of [56, 52, 48])
			expect(widgetLines([busy], "main", NOW, theme, width)).toEqual([
				" 🦑 main ⏺ · main",
				" └ ◒ researcher-with-a-r… · researcher-…",
				"     Inspect things",
				"     ↳ localFetch x.ts",
			]);
		// From 60 columns the goal and the action share the grid row when the action fits whole.
		expect(groupOf(widgetLines([busy], "main", NOW, theme, 100), "researcher-with-a-r")[0]).toMatch(
			/^ └ ◒ researcher-with-a-r… · researcher-… · Inspect things › localFetch x\.ts +1m$/,
		);
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

	it("aligns the columns: every grid row puts its separators, elapsed time, tokens, goal and action at the same offsets", () => {
		const lines = widgetLines(team, "main-aaaaaa", NOW, theme, 160);
		const rows = ["researcher-3fa9", "general-77aa", "reviewer-a1b2"].map((name) => groupOf(lines, name)[0]);
		const ends = (needle: RegExp) =>
			rows.map((row) => {
				const hit = needle.exec(row);
				return hit ? hit.index + hit[0].length : -1;
			});
		// The first separator, and the right-aligned elapsed time.
		expect(new Set(rows.map((row) => row.indexOf(" · "))).size).toBe(1);
		expect(ends(/2m14s|5s|45s/)).toEqual(Array(3).fill(ends(/2m14s/)[0]));
		// Tokens (from 160 columns) end at the same cell; the goal column starts at the same cell.
		const [first, , last] = ends(/\d+k tok/);
		expect(first).toBe(last);
		expect(rows[0].indexOf("Find where")).toBe(rows[2].indexOf("Review the diff"));
		// Actions that fit whole follow the goal column at the same cell.
		expect(rows[0].indexOf("›")).toBe(rows[1].indexOf("›"));
		expect(lines.every((row) => visibleWidth(row) <= 160)).toBe(true);
	});

	it("roots the list at this session's row (mark and time, no tally or cost), then each agent's grid row, working first, and its stats when open", () => {
		const lines = widgetLines(team, "main-aaaaaa", NOW, theme, 200);
		const squash = (line: string | undefined) => line!.replace(/ +/g, " ");
		// No tally and no cost on the root row: the marks say the states, and the footer's Σ is the one total.
		expect(squash(lines[0])).toBe(" 🦑 main-aaaaaa ⏺ · main 1m");
		// The grid row says who, spend and what (goal › action); the stats line under the name says how.
		expect(squash(lines[1])).toBe(
			" ├ ◒ researcher-3fa9 · researcher · Find where tools register › localSearch registerTool 15k tok · ≈$0.04 2m14s",
		);
		expect(squash(lines[2])).toBe(" │ claude-opus-4-5 15k tok · 12 tool calls");
		// A grandchild sits under its parent with the tree line beside it; no goal or usage leaves those cells empty.
		expect(squash(lines[3])).toBe(" │ └ ◒ general-77aa · general · › bash yarn test 5s");
		expect(squash(lines[4])).toBe(" │ claude-haiku-4-5 1 tool call");
		// The waiting messages close the goal cell; the locks are on the stats line.
		expect(squash(lines[5])).toBe(" └ ⏺ reviewer-a1b2 · reviewer · Review the diff ✉ 1 5k tok · 45s");
		expect(squash(lines[6])).toBe(" gpt-5 5k tok · 3 tool calls · 1 lock");
		expect(lines).toHaveLength(7);
		expect(lines.join("\n")).not.toMatch(/working|idle|🐙/);
		// A role the id already starts with (`researcher-3fa9`) still shows.
		expect(lines.slice(1).join("\n")).toMatch(/ · researcher · /);
		// Provider prefixes stay out of the panel.
		expect(lines.join("\n")).not.toMatch(/anthropic\//);
	});

	it("gives way in ladder order: tokens below 160, the action to a ↳ line, then the elapsed time; the cost stays; below 60 the narrow form", () => {
		const at = (width: number) => {
			const lines = widgetLines(team, "main-aaaaaa", NOW, theme, width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			const start = lines.findIndex((line) => line.includes("researcher-3fa9"));
			return { lines, head: lines[start], below: lines.slice(start + 1, start + 3) };
		};
		const wide = at(120);
		expect(wide.head).toBe(
			" ├ ◒ researcher-3fa9 · researcher · Find where tools register › localSearch registerTool                    ≈$0.04 2m14s",
		);
		expect(wide.below[0]).toMatch(/^ │   claude-opus-4-5 +15k tok · 12 tool calls$/);
		// The action does not fit whole beside the goal: it moves below, whole, and the goal stays whole.
		const medium = at(70);
		expect(medium.head).toMatch(/^ ├ ◒ researcher-3fa9 · researcher · Find where tools register +≈\$0\.04$/);
		expect(medium.below[0]).toMatch(/^ │   claude-opus-4-5 +15k tok · 12 tool calls$/);
		expect(medium.below[1]).toBe(" │   ↳ localSearch registerTool");
		// Narrower: the elapsed time leaves every row, the role is cut to 8 cells, and the cost leaves with it.
		const narrow = at(60);
		expect(narrow.head).toBe(" ├ ◒ researcher-3fa9 · researc… · Find where tools register");
		expect(narrow.lines.join("\n")).not.toMatch(/2m14s|45s/);
		expect(narrow.lines.join("\n")).toContain("Review the diff ✉ 1");
		// Below 60 columns: the narrow form, goal and action under the name.
		const compact = at(56);
		expect(compact.head).toBe(" ├ ◒ researcher-3fa9 · researcher");
		expect(compact.lines.slice(2, 5)).toEqual([
			" │   Find where tools register",
			" │   claude-opus-4-5             15k tok · 12 tool calls",
			" │   ↳ localSearch registerTool",
		]);
		expect(compact.lines.join("\n")).toContain(" └ ⏺ reviewer-a1b2 · reviewer · ✉ 1");
	});

	it("keeps a long activity whole on a ↳ line under the goal column, and inline when it fits, never dropping tokens or the cached share", () => {
		const busy = member("glowing-prawn", {
			parentId: "main-aaaaaa",
			status: "working",
			goal: "ask parent a color, sleep, report",
			model: "guy-provider/claude-haiku-5-5",
			joinedAt: NOW - 5_000,
			// `input` is every prompt token: 275 new ones and 58.4k read from cache.
			input: 58_675,
			cacheRead: 58_400,
			output: 135,
			activity: "Running shell: sleep 25",
		});
		const lines = widgetLines([member("main-aaaaaa"), busy], "main-aaaaaa", NOW, theme, 70);
		const [row, stats] = groupOf(lines, "glowing-prawn");
		expect(row).toBe(" └ ◒ glowing-prawn · glowing-pra… · ask parent a color, sleep, re…  5s");
		expect(stats).toBe("     claude-haiku-5-5                             410 tok · 99% cached");
		const action = lines[lines.indexOf(stats) + 1];
		expect(action.trim()).toBe("↳ Running shell: sleep 25");
		expect(action.indexOf("↳")).toBe(row.indexOf("glowing-prawn"));
		// With room (200 columns) the whole goal shows too.
		expect(
			groupOf(widgetLines([member("main-aaaaaa"), busy], "main-aaaaaa", NOW, theme, 200), "glowing-prawn")[0],
		).toContain("ask parent a color, sleep, report › Running shell: sleep 25");
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
		// The root row has no tally: each agent's mark says its state, and `left` is on the departed agent's ↳ line.
		expect(lines).toEqual([
			" 🦑 main-aaaaaa ⏺  · main                                                                                             1m",
			" ├ ◒ wobbly-siphon · wobbly-siph…                                                                                     1m",
			" └ ⏺ sly-crab      · sly-crab                                                                                        15s",
			"     ↳ left",
		]);
		// The elapsed time stays the run's length while the row is shown (`FINISHED_MS` after it left, inclusive).
		const later = widgetLines(beat(lastShown), "main-aaaaaa", lastShown, theme, 120, [], undefined, finished);
		const [laterHead, laterReason] = groupOf(later, "sly-crab");
		expect(laterHead).toMatch(/^ └ ⏺ sly-crab +· sly-crab +15s$/);
		expect(laterReason).toBe("     ↳ left");
		// Then the row is gone (root plus the live agent's row); a lone departed agent keeps the panel for that long only.
		expect(
			widgetLines(beat(lastShown + 1), "main-aaaaaa", lastShown + 1, theme, 120, [], undefined, finished),
		).toHaveLength(2);
		expect(widgetLines([main], "main-aaaaaa", NOW, theme, 120, [], undefined, finished)).toHaveLength(3);
		expect(widgetLines([main], "main-aaaaaa", lastShown + 1, theme, 120, [], undefined, finished)).toEqual([]);
		// Collapsed to one grid row per agent (few terminal rows) it keeps its tree connector and its neutral mark.
		const [row] = collapsedRows([{ member: gone, depth: 0, doneAt: NOW - 9_000 }], NOW, theme, 120);
		expect(row).toMatch(/^ └ ⏺ sly-crab · sly-crab +15s$/);
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

	it("shows new tokens with the cached share and marks a model without pricing in its row", () => {
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
		// 72k new prompt tokens and 35k output; the 1.128M cache reads show as the cached share. The root row has no total.
		expect(lines).toEqual([
			" 🦑 main-aaaaaa ⏺ · main 1m",
			" ├ ⏺ researcher-3fa9 · researcher 107k tok 94% cached · ≈$2.28 1m",
			" │ 107k tok · 94% cached · 2 tool calls",
			" └ ⏺ general-77aa · general 4.5k tok · cost n/a 1m",
			" 4.5k tok · 1 tool call",
		]);
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

	it("keeps healthy nested agents whose parent's heartbeat stopped", () => {
		const lines = widgetLines(
			[
				member("main-aaaaaa"),
				member("general-dead", { parentId: "main-aaaaaa", status: "working", updatedAt: NOW - 20_000 }),
				member("explore-kid", { parentId: "general-dead", status: "working" }),
			],
			"main-aaaaaa",
			NOW,
			theme,
			120,
		).join("\n");
		expect(lines).toContain("explore-kid");
		expect(lines).not.toContain("general-dead");
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
				live("researcher-bbbbbb", { parentId: "main-aaaaaa", model: "claude-haiku-4-5" }),
				live("tester-cccccc", { parentId: "main-aaaaaa" }),
			],
			"main-aaaaaa",
			Date.now(),
			theme,
			200,
			traffic,
		);
		expect(lines.join("\n")).toContain(`#${mine}`);
		// The message block follows its sender's row and stats line, under the sender's tree line.
		const at = lines.findIndex((line) => line.includes(`#${mine}`));
		expect(lines[at - 2]).toMatch(/^ ├ ⏺ researcher-bbbbbb /);
		expect(lines[at - 1]).toBe(" │   claude-haiku-4-5");
		expect(lines[at]).toMatch(new RegExp(`^ │   ✉ #${mine} → tester-cccccc · queued · `));
		expect(lines[at + 1]).toBe(' │     "ours"');
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
		// One block: the latest message's head, then its body on two lines ending in a one-character ellipsis.
		const heads = lines.filter((line) => line.includes("✉"));
		expect(heads).toHaveLength(1);
		expect(heads[0]).toMatch(/^ {5}✉ #5 → tester-c · delivered · /);
		const block = lines.slice(lines.indexOf(heads[0]));
		expect(block).toHaveLength(3);
		expect(plain(block)[2]).toMatch(/^ {8}y+…"$/);
		expect(plain(lines)[1]).toMatch(/^ └ ⏺ researcher-bbbbbb · researc… · x+…$/);
		expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
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
		expect(ctx.ui.statuses.get("octocode-running")).toBe("🐙 2 agents");
		view.setBackground([]);
		expect(ctx.ui.statuses.get("octocode-running")).toBeUndefined();
		view.setBackground(["general-1a2b"]);
		view.stop(ctx);
		expect(ctx.ui.statuses.get("octocode-running")).toBeUndefined();
		team.stop();
	});
});
