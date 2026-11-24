import fs from "node:fs";
import path from "node:path";
import { visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { HEARTBEAT_MS, LINE_FLUSH_MS, Activity as RowActivity } from "../../src/octocode/team/session/activity.ts";
import { ActivityHold, THINKING_HOLD_MS } from "../../src/octocode/team/panel/hold.ts";
import { AgentsView, widgetLines } from "../../src/octocode/team/panel.ts";
import type { Team } from "../../src/octocode/team/session.ts";
import { TeamTicker } from "../../src/octocode/team/ticker.ts";
import { Activity as LineModel } from "../../src/octocode/ui/activity-model.ts";
import { RunningWork } from "../../src/octocode/shared/running-work.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { fakeCtx, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const NOW = 1_000_000;
const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "general",
	pid: process.pid,
	status: "working",
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

afterEach(() => vi.useRealTimers());

describe("a child's activity line reaches its row throttled", () => {
	beforeEach(() => vi.useFakeTimers({ now: NOW }));

	function rowActivity() {
		const me = member("kid-0001");
		const save = vi.fn(() => true);
		const db = { save, renew: vi.fn() } as never;
		const activity = new RowActivity({
			me: () => me,
			db: () => db,
			held: { holding: false, lost: () => [] },
			mail: { notice: vi.fn() },
			route: () => undefined,
			renewChildren: vi.fn(),
		});
		activity.flush(db);
		save.mockClear();
		return { activity, db, save, me };
	}

	it("writes a changed line only after the flush interval, once, and nothing for an unchanged line", () => {
		const { activity, db, save, me } = rowActivity();
		activity.setLine("Thinking: read the file.");
		vi.advanceTimersByTime(LINE_FLUSH_MS - 100);
		expect(activity.heartbeat(db)).toBe(false);
		expect(save).not.toHaveBeenCalled();
		vi.advanceTimersByTime(150);
		expect(activity.heartbeat(db)).toBe(true);
		expect(save).toHaveBeenCalledTimes(1);
		expect(me.activity).toBe("Thinking: read the file.");
		// The same line again is no change; a later tick writes nothing.
		activity.setLine("Thinking: read the file.");
		vi.advanceTimersByTime(LINE_FLUSH_MS + 1);
		expect(activity.heartbeat(db)).toBe(false);
	});

	it("keeps the idle heartbeat at HEARTBEAT_MS and still writes a status change at once", () => {
		const { activity, db, save } = rowActivity();
		vi.advanceTimersByTime(HEARTBEAT_MS - 1);
		expect(activity.heartbeat(db)).toBe(false);
		vi.advanceTimersByTime(1);
		expect(activity.heartbeat(db)).toBe(true);
		save.mockClear();
		activity.idle();
		expect(activity.heartbeat(db)).toBe(true);
		expect(save).toHaveBeenCalledTimes(1);
	});

	it("clearing the line is a change too", () => {
		const { activity, db, me } = rowActivity();
		activity.setLine("Running bash ls");
		vi.advanceTimersByTime(LINE_FLUSH_MS);
		activity.heartbeat(db);
		activity.setLine(undefined);
		vi.advanceTimersByTime(LINE_FLUSH_MS);
		expect(activity.heartbeat(db)).toBe(true);
		expect(me.activity).toBeUndefined();
	});
});

describe("ActivityHold", () => {
	const kid = (activity?: string, extra: Partial<Member> = {}) =>
		member("kid-0001", { ...(activity ? { activity } : {}), ...extra });
	const shown = (hold: ActivityHold, line: string | undefined, at: number) => hold.apply([kid(line)], at)[0]?.activity;

	it("holds a thinking line for the dwell time, then follows the newest line", () => {
		const hold = new ActivityHold();
		expect(shown(hold, "Thinking: one.", 0)).toBe("Thinking: one.");
		expect(shown(hold, "Thinking: two.", THINKING_HOLD_MS - 1)).toBe("Thinking: one.");
		expect(shown(hold, "Thinking: three.", THINKING_HOLD_MS)).toBe("Thinking: three.");
	});

	it("keeps a running bash command, with its elapsed time, until the next tool replaces it", () => {
		const hold = new ActivityHold();
		expect(shown(hold, "Running bash yarn test", 0)).toBe("Running bash yarn test");
		expect(shown(hold, "Running bash yarn test", 12_000)).toBe("Running bash yarn test · 12s");
		// The command ended: between steps and while thinking, the row still names it.
		expect(shown(hold, undefined, 13_000)).toBe("Running bash yarn test · 13s");
		expect(shown(hold, "Thinking: it passed.", 14_000)).toBe("Running bash yarn test · 14s");
		expect(shown(hold, "Running read src/a.ts", 15_000)).toBe("Running read src/a.ts");
	});

	it("forgets a child that stops working and leaves the input rows alone", () => {
		const hold = new ActivityHold();
		const rows = [kid("Running bash ls")];
		hold.apply(rows, 0);
		expect(hold.apply([kid(undefined, { status: "idle" })], 1)[0]?.activity).toBeUndefined();
		expect(shown(hold, undefined, 2)).toBeUndefined();
		expect(rows[0]?.activity).toBe("Running bash ls");
	});
});

describe("the panel's activity rows", () => {
	const lineOf = (n: number) =>
		`Running bash yarn vitest run --config vitest.octocode.config.ts test/case-${n}.test.ts`;

	for (const count of [1, 5]) {
		for (const width of [50, 80, 120, 200]) {
			it(`draws ${count} running child(ren) at ${width} columns within the width, each with its command`, () => {
				const kids = Array.from({ length: count }, (_, i) =>
					member(`kid-000${i}`, { parentId: "main-aaaaaa", goal: "fix it", activity: lineOf(i) }),
				);
				const team = [member("main-aaaaaa", { status: "idle" }), ...kids];
				const rows = widgetLines(team, "main-aaaaaa", NOW, theme, width);
				for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
				const text = rows.map(stripAnsi).join("\n");
				for (let i = 0; i < count; i++) expect(text).toContain(`kid-000${i}`);
				// Each child's command shows at least its first words, inline or on its own row.
				expect(text.match(/Running bash yarn/g)?.length ?? 0).toBe(count);
			});
		}
	}
});

describe("the activity line is clean where it is produced", () => {
	const lineFor = (command: string): string => {
		const line = new LineModel();
		line.start(0);
		line.toolStart("1", "bash", { command }, 0);
		return line.describe() ?? "";
	};

	it("shows no bearer token, URL password or KEY=value secret", () => {
		const secrets = [
			"curl -H 'Authorization: Bearer abcdef0123456789abcdef0123456789' https://api.test/x",
			"git clone https://user:hunter2pass@github.com/a/b.git",
			"API_KEY=sk-live-0123456789abcdef0123456789 node run.js",
			"export GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz && yarn test",
		];
		for (const command of secrets) {
			const line = lineFor(command);
			expect(line).toMatch(/^Running bash/i);
			expect(line).not.toMatch(/abcdef0123456789|hunter2pass|sk-live-0123|ghp_0123/);
		}
	});

	it("shows only the first line of a multi-line command", () => {
		const line = lineFor("echo first\nSECRET_SECOND_LINE=1\nrm -rf nothing");
		expect(line).toContain("echo first");
		expect(line).not.toMatch(/SECOND_LINE|rm -rf/);
	});

	it("stores the line without terminal controls", () => {
		const me = member("kid-0001");
		const activity = new RowActivity({
			me: () => me,
			db: () => undefined,
			held: { holding: false, lost: () => [] },
			mail: { notice: vi.fn() },
			route: () => undefined,
			renewChildren: vi.fn(),
		});
		activity.setLine("Running bash echo \u001b]0;pwned\u0007hi");
		expect(me.activity).not.toMatch(/\u001b|\u0007/);
	});
});

describe("a child's activity stays on the screen", () => {
	it("is drawn by the panel without any message to the parent session", () => {
		const secretish = "Thinking: the ZEBRA-MARKER plan.";
		const state = {
			members: [
				member("main-aaaaaa", { status: "idle", updatedAt: Date.now() }),
				member("kid-0001", {
					parentId: "main-aaaaaa",
					activity: secretish,
					updatedAt: Date.now(),
					joinedAt: Date.now(),
				}),
			],
			traffic: [] as never[],
		};
		let tick: (() => void) | undefined;
		const team = {
			id: "main-aaaaaa",
			view: state,
			approvals: undefined,
			poll: () => undefined,
			watch: (cb: () => void) => {
				tick = cb;
				return () => undefined;
			},
		} as unknown as Team;
		const base = fakeCtx({ cwd: tmp() });
		const reaches: string[] = [];
		const ctx = new Proxy(base, {
			get(target, key, receiver) {
				if (typeof key === "string" && /send|append|steer|queue/i.test(key)) reaches.push(key);
				return Reflect.get(target, key, receiver);
			},
		});
		const view = new AgentsView(team, new RunningWork());
		view.start(ctx);
		tick?.();
		expect(base.ui.widgets.has("octocode-agents")).toBe(true);
		const statuses = JSON.stringify([...base.ui.statuses.entries()]);
		expect(statuses).not.toContain("ZEBRA-MARKER");
		expect(reaches).toEqual([]);
		view.stop(ctx);
	});
});

describe("TeamTicker.poll", () => {
	it("refreshes and calls watchers only when the database file changed, at most every 250 ms", async () => {
		const dir = tmp();
		const file = path.join(dir, "team.db");
		fs.writeFileSync(file, "a");
		let reads = 0;
		const ticker = new TeamTicker({
			joined: () => false,
			beat: () => undefined,
			dbFile: () => file,
			read: () => {
				reads += 1;
				return { members: [], traffic: [] };
			},
			maxAgeMs: 60_000,
			resumed: () => undefined,
		});
		let calls = 0;
		const stop = ticker.watch(() => (calls += 1));
		const base = reads;
		const callsBase = calls;
		ticker.poll(1_000_000);
		expect(reads).toBe(base); // unchanged file
		fs.writeFileSync(file, "bb-changed");
		await Promise.resolve(); // the stamp is shared within one event-loop turn
		ticker.poll(1_000_100); // inside the poll interval
		expect(reads).toBe(base);
		ticker.poll(1_000_300);
		expect(reads).toBe(base + 1);
		expect(calls).toBe(callsBase + 1);
		ticker.poll(1_000_700);
		expect(reads).toBe(base + 1);
		stop();
	});
});
