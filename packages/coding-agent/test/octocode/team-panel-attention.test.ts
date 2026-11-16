import { visibleWidth } from "@octocodeai/octocode-tui";
import { describe, expect, it } from "vitest";
import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import { FINISHED_MS } from "../../src/octocode/team/panel/compact.ts";
import { FinishedTracker } from "../../src/octocode/team/panel/finished.ts";
import { needsYou } from "../../src/octocode/team/panel/attention.ts";
import { widgetLines } from "../../src/octocode/team/panel.ts";
import { panelState } from "../../src/octocode/team/panel/state.ts";
import { theme } from "./fake-host.ts";

const NOW = 1_000_000;
const ME = "main-aaaaaa";
const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "general",
	pid: process.pid,
	parentId: ME,
	status: "working",
	joinedAt: NOW - 60_000,
	updatedAt: NOW,
	toolCalls: 3,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	goal: "Check timeout handling",
	...extra,
});
const ask = (from: string, id = 11, extra: Partial<Traffic> = {}): Traffic => ({
	id,
	from,
	to: [ME],
	text: "Should I delete the legacy timeout path?",
	at: NOW - 30_000,
	state: "awaiting reply",
	...extra,
});
const main = member(ME, { parentId: undefined, status: "idle" });
const lines = (members: Member[], traffic: Traffic[] = [], width = 120, rows?: number, finished = []) =>
	widgetLines([main, ...members], ME, NOW, theme, width, traffic, rows, finished).map((line) =>
		line.replace(/\x1b\[[0-9;]*m/g, ""),
	);

/** An agent's name line and the stats line under it: the state word sits on the second line from 60 columns. */
const groupOf = (out: string[], id: string) => {
	const at = out.findIndex((line) => line.includes(id));
	return `${out[at]}\n${out[at + 1]}`;
};
const messageRow = (out: string[]) => out.find((line) => line.includes("↳"))!;

describe("agents panel: the agent that needs you", () => {
	it("marks an agent with an unanswered question to this session, sorts it first and leads the header with the count", () => {
		const out = lines(
			[member("busy-0001"), member("quiet-0002", { status: "idle" }), member("plucky-otter")],
			[ask("plucky-otter")],
		);
		expect(out[0]).toContain("1 asks parent");
		expect(out.join("\n")).not.toContain("needs you");
		expect(out.join("\n")).not.toContain("→ you");
		expect(out[0]).toContain("1 working");
		expect(out[0]).toContain("1 idle");
		expect(out[0].indexOf("asks parent")).toBeLessThan(out[0].indexOf("working"));
		expect(out[1]).toMatch(/^ [├└] ◇ 🐙 plucky-otter/);
		expect(groupOf(out, "plucky-otter")).toMatch(/^ [├└] ◇ 🐙 plucky-otter[^\n]*\n[^\n]*asks parent/);
		// The parent agent owns this answer, not the user; the message follows the agent's two lines.
		expect(out[3]).toContain("↳");
		expect(out[3]).toContain("#11 → parent");
		expect(out[3]).not.toContain("/agents tell");
		expect(out[3]).toContain("awaiting parent");
		expect(out[3]).toContain('"Should I delete');
	});

	it("treats a member waiting for an approval as needing the user", () => {
		const out = lines([member("calm-heron", { waiting: "approval" }), member("swift-lynx")]);
		expect(out[0]).toContain("◇ 1 needs you");
		expect(out[1]).toContain("◇ 🐙 calm-heron");
		expect(out[2]).toContain("needs you");
		expect(out[3]).toContain("waiting for your approval");
	});

	it("keeps user question dialogs distinct from messages awaiting the parent", () => {
		const out = lines(
			[member("calm-heron", { waiting: "reply" }), member("plucky-otter")],
			[ask("calm-heron"), ask("plucky-otter")],
		);
		expect(out[0]).toContain("◇ 1 needs you");
		expect(out[0]).toContain("1 asks parent");
		expect(out.join("\n")).toContain("waiting for your answer");
		expect(out.join("\n")).toContain("awaiting parent");
	});

	it("reports approval, with the question's message and count, when a member waits for both", () => {
		const needs = needsYou(
			[main, member("calm-heron", { waiting: "approval" })],
			[ask("calm-heron", 3), ask("calm-heron", 4)],
			ME,
		);
		expect(needs.get("calm-heron")).toMatchObject({ kind: "approval", count: 2, message: { id: 4 } });
	});

	it("hoists a branch whose grandchild needs you above its quiet siblings", () => {
		const out = lines(
			[member("quiet-0001"), member("parent-0002"), member("child-0003", { parentId: "parent-0002" })],
			[ask("child-0003")],
		);
		const order = out.filter((line) => /[├└] /.test(line)).map((line) => line.match(/(quiet|parent|child)-\d{4}/)?.[0]);
		expect(order.slice(0, 2)).toEqual(["parent-0002", "child-0003"]);
	});

	it("does not call an answered question, or another session's question, a need", () => {
		const out = lines(
			[member("a-0001")],
			[ask("a-0001", 5, { state: "answered" }), ask("a-0001", 6, { to: ["main-zzzzzz"] })],
		);
		expect(out.join("\n")).not.toContain("needs you");
		expect(out.join("\n")).not.toContain("#5");
	});

	it("keeps the mark, the label and the ✉ count in every width down to 40 columns, with six agents", () => {
		const agents = ["a", "b", "c", "d", "e", "f"].map((c) =>
			member(`researcher-${c}${c}${c}${c}`, { pending: c === "f" ? 2 : 0 }),
		);
		for (const width of [40, 48, 60, 80, 140]) {
			for (const rows of [undefined, 40, 24]) {
				const out = lines(agents, [ask("researcher-ffff")], width, rows);
				const at = out.findIndex(
					(line) =>
						line.includes("researcher-f") ||
						line.includes("research…") ||
						(/◇ .*asks parent/.test(line) && !line.includes("🦑")),
				);
				expect(at, `${width}x${rows}`).toBeGreaterThan(0);
				// From 60 columns the label is the state word on the second line; narrower it shares the head row.
				const row =
					width >= 60 && out[at + 1] && !out[at].includes("asks parent") ? `${out[at]}\n${out[at + 1]}` : out[at];
				expect(row).toContain("◇");
				expect(row).toContain("asks parent");
				expect(row).toContain("✉ 2");
				expect(out[0]).toContain("1 asks parent");
				for (const line of out) expect(visibleWidth(line), `${width}x${rows}: ${line}`).toBeLessThanOrEqual(width);
			}
		}
	});

	it("sorts a needs-you agent into the rows that fit when more agents than rows exist", () => {
		const agents = Array.from({ length: 9 }, (_, i) => member(`worker-000${i}`));
		const out = lines([...agents, member("plucky-otter", { joinedAt: NOW - 5_000 })], [ask("plucky-otter")], 80, 24);
		expect(out.length).toBeLessThanOrEqual(8);
		expect(out.join("\n")).toContain("plucky-otter");
		expect(out.join("\n")).toContain("asks parent");
	});

	it("keeps the parent as reply owner on narrow lines", () => {
		const wide = messageRow(lines([member("plucky-otter")], [ask("plucky-otter")], 140));
		const mid = messageRow(lines([member("plucky-otter")], [ask("plucky-otter")], 92));
		const slim = messageRow(lines([member("plucky-otter")], [ask("plucky-otter")], 56));
		expect(wide).toContain('"Should I delete the legacy timeout path?"');
		expect(mid).not.toContain("/agents tell");
		expect(mid).toContain('"Should');
		expect(slim).toContain("awaiting parent");
		expect(slim).not.toContain("→ you");
	});
});

describe("agents panel: messages under their sender", () => {
	it("puts an agent's latest message on its own row, and leaves other sessions' traffic out", () => {
		const out = lines(
			[member("inky-kraken"), member("calm-heron")],
			[
				{
					id: 14,
					from: "inky-kraken",
					to: ["calm-heron"],
					text: "review the diff please",
					at: NOW - 12_000,
					state: "awaiting reply",
				},
				{ id: 9, from: "inky-kraken", to: ["calm-heron"], text: "older message", at: NOW - 90_000, state: "delivered" },
				{ id: 20, from: "other-x", to: ["other-y"], text: "foreign", at: NOW, state: "queued" },
				{ id: 21, from: ME, to: ["calm-heron"], text: "from me", at: NOW, state: "queued" },
				{ id: 22, from: "calm-heron", to: [ME], text: "already in my transcript", at: NOW, state: "answered" },
			],
		);
		const at = out.findIndex((line) => line.includes("inky-kraken"));
		// The message follows the sender's two lines.
		expect(out[at + 2]).toContain('↳ #14 → calm-heron · awaiting reply · 12s ago · "review the diff please"');
		const text = out.join("\n");
		for (const hidden of ["older message", "foreign", "from me", "already in my transcript"])
			expect(text).not.toContain(hidden);
	});

	it("keeps every message line when the terminal allows, and only the waiting ones when it does not", () => {
		const agents = [member("a-0001"), member("b-0002"), member("c-0003"), member("d-0004")];
		const traffic = ["a-0001", "b-0002", "c-0003"].map((from, i) => ({
			id: i + 1,
			from,
			to: ["d-0004"],
			text: "hello there",
			at: NOW - 1_000,
			state: "delivered" as const,
		}));
		expect(lines(agents, traffic, 120, 60).filter((line) => line.includes("↳"))).toHaveLength(3);
		const tight = lines(agents, [...traffic, ask("d-0004", 7)], 120, 18);
		expect(tight.length).toBeLessThanOrEqual(6);
		expect(tight.filter((line) => line.includes("↳"))).toEqual([expect.stringContaining("#7")]);
	});
});

describe("agents panel: finished rows", () => {
	const gone = member("old-gecko", { joinedAt: NOW - 100_000 });
	const finished = (outcome: "done" | "failed" | "stopped" | "blocked", headline?: string) => [
		{ member: gone, at: NOW - 1_000, end: { outcome, ...(headline ? { headline } : {}) } },
	];

	it("shows the outcome, a headline and the tally; unknown outcomes stay neutral", () => {
		const done = lines([], [], 120, undefined, finished("done", "## 3 gaps found; fix plan in report") as never);
		expect(done[1]).toMatch(/✓ 🐙 old-gecko/);
		expect(done[2]).toMatch(/done +1m39s/);
		expect(done[3]).toContain('↳ "3 gaps found; fix plan in report"');
		expect(done[0]).toContain("✓ 1 done");
		const failed = lines([], [], 120, undefined, finished("failed", "vitest: 4 failures") as never);
		expect(failed[1]).toMatch(/✗ 🐙 old-gecko/);
		expect(failed[2]).toMatch(/failed/);
		expect(failed[0]).toContain("✗ 1 failed");
		const stopped = lines([], [], 120, undefined, finished("stopped") as never);
		expect(stopped[1]).toMatch(/◼ 🐙 old-gecko/);
		expect(stopped[2]).toMatch(/stopped/);
		const blocked = lines([], [], 120, undefined, finished("blocked", "needs a decision") as never);
		expect(blocked[0]).toContain("1 blocked");
		expect(blocked[0]).not.toContain("needs you");
		expect(blocked[1]).toMatch(/◇ 🐙 old-gecko/);
		expect(blocked[2]).toMatch(/blocked/);
		const unknown = lines([], [], 120, undefined, [{ member: gone, at: NOW - 1_000 }] as never);
		expect(unknown[1]).toMatch(/○ 🐙 old-gecko/);
		expect(unknown[2]).toMatch(/left/);
	});

	it("keeps the outcome the host reports after the row left, for FINISHED_MS", () => {
		const live = member("old-gecko");
		const reported: { end?: { outcome: "failed"; headline: string } } = {};
		const tracker = new FinishedTracker(() => reported.end);
		tracker.update(ME, [main, live], [live], NOW);
		tracker.update(ME, [main], [], NOW + 1_000);
		expect(tracker.finished[0]?.end).toBeUndefined();
		reported.end = { outcome: "failed", headline: "boom" };
		expect(tracker.finished[0]?.end).toEqual({ outcome: "failed", headline: "boom" });
		const entry = { member: live, depth: 0, doneAt: NOW, end: { outcome: "failed" as const } };
		expect(panelState(entry, NOW)).toEqual({ state: "failed", label: "failed" });
		tracker.update(ME, [main], [], NOW + 1_000 + FINISHED_MS + 1);
		expect(tracker.finished).toEqual([]);
	});

	it("keeps the outcome label in the collapsed row of a short terminal", () => {
		const agents = Array.from({ length: 4 }, (_, i) => member(`w-000${i}`));
		const out = lines(agents, [], 80, 12, finished("failed", "boom") as never);
		expect(out.join("\n")).toMatch(/✗ old-gecko · failed|\+\d more/);
	});
});
