import path from "node:path";
import { animationClock, visibleWidth } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { TimerRow } from "../../../db/src/api.ts";
import { RunningWork, type WorkRow, workCounts } from "../../src/octocode/shared/running-work.ts";
import { AgentsView, widgetLines } from "../../src/octocode/team/panel.ts";
import { collapsedRows } from "../../src/octocode/team/panel/compact.ts";
import { roster } from "../../src/octocode/team/panel/roster.ts";
import { PanelMotion, type Moving } from "../../src/octocode/team/panel/motion.ts";
import { nextMinuteDelay, workRows } from "../../src/octocode/team/panel/work.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { encodeCondition } from "../../src/octocode/timer/conditions/index.ts";
import { timerWorkRows } from "../../src/octocode/timer/work.ts";
import { fakeCtx, fakeHost, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const NOW = 1_000_000;
const MARKS = { live: "●", waiting: "◇" };
const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: id.replace(/-[0-9a-f]{4,6}$/, ""),
	pid: process.pid,
	status: "working",
	joinedAt: NOW - 125_000,
	updatedAt: NOW,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});

const bash: WorkRow = {
	kind: "bash",
	id: "bash-3",
	title: "run the unit tests",
	detail: "yarn vitest run",
	startedAt: NOW - 125_000,
};
const bare: WorkRow = { kind: "bash", id: "bash-4", title: "tail -f server.log", startedAt: NOW - 5_000 };
const timer: WorkRow = {
	kind: "timer",
	id: "#4",
	title: "until `nc -z localhost 5173` exits 0",
	detail: "open the app",
	dueAt: NOW + 240_000,
};
const external: WorkRow = { kind: "external", id: "codex-1", title: "review the diff", startedAt: NOW - 30_000 };
const unlisted: WorkRow = { kind: "agent", id: "general-1a2b", title: "running in the background" };

const render = (work: WorkRow[], width = 100, cap?: number) => workRows(work, NOW, theme, width, MARKS, cap);

describe("running work rows", () => {
	it("draws one typed row per item: bash with its reason, command and elapsed time", () => {
		const [first, second] = render([bash, bare]);
		expect(first).toContain("bash");
		expect(first).toContain("bash-3");
		expect(first).toContain("run the unit tests › yarn vitest run");
		expect(first).toMatch(/2m05s\s*$/);
		// No reason: the first line of the command stands in for it.
		expect(second).toContain("tail -f server.log");
		expect(second).not.toContain("›");
		expect(second).toMatch(/5s\s*$/);
	});

	it("draws a timer with what it waits for, its note and its time left, and an overdue one as due", () => {
		const [row] = render([timer]);
		expect(row).toContain("timer");
		expect(row).toContain("#4");
		expect(row).toContain("until `nc -z localhost 5173` exits 0 › open the app");
		expect(row).toMatch(/in 4m\s*$/);
		expect(render([{ ...timer, dueAt: NOW - 1 }])[0]).toMatch(/due\s*$/);
	});

	it("draws an external prompt and a background subagent the team does not list", () => {
		const [ext, agent] = render([external, unlisted]);
		expect(ext).toContain("ext");
		expect(ext).toContain("codex-1");
		expect(ext).toMatch(/30s\s*$/);
		expect(agent).toContain("agent");
		expect(agent).toContain("general-1a2b");
	});

	it("paints timers in the warning tone and the other types in the accent tone", () => {
		const tones: string[] = [];
		const painter = { ...(theme as object), fg: (color: string, text: string) => (tones.push(color), text) } as never;
		workRows([bash, timer], NOW, painter, 100, MARKS);
		expect(tones).toContain("accent");
		expect(tones).toContain("warning");
	});

	it("keeps every row within the width, down to a few cells", () => {
		const long: WorkRow[] = [
			{ ...bash, title: "x".repeat(300), detail: "y".repeat(300) },
			{ ...timer, id: `#${"9".repeat(40)}` },
			external,
			unlisted,
		];
		for (const width of [3, 8, 12, 20, 30, 40, 80, 200]) {
			for (const line of render(long, width)) expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
		}
		// A row that has the room shows its text cut with an ellipsis, and its clock stays.
		const [cut] = render([{ ...bash, title: "z".repeat(300), detail: undefined }], 50);
		expect(cut).toContain("…");
		expect(cut).toMatch(/2m05s\s*$/);
	});

	it("collapses rows past the cap into one +N more row", () => {
		const many = Array.from({ length: 10 }, (_, index): WorkRow => ({ ...bash, id: `bash-${index + 1}` }));
		const lines = render(many, 100, 4);
		expect(lines).toHaveLength(4);
		expect(lines[3]).toContain("+7 more");
		// With room for one row the block says how many run.
		expect(render(many, 100, 1)).toEqual([" 10 running"]);
		// Without a terminal height the block is bounded all the same.
		expect(render(many)).toHaveLength(6);
		expect(render(many).at(-1)).toContain("+5 more");
		expect(render(many.slice(0, 3), 100, 4)).toHaveLength(3);
	});
});

describe("the work block in the widget", () => {
	it("is empty when idle: no agents and no work", () => {
		expect(widgetLines([], undefined, NOW, theme, 100)).toEqual([]);
		expect(widgetLines([member("main-0001")], "main-0001", NOW, theme, 100, [], 24, [], [])).toEqual([]);
	});

	it("stands alone when the team has no subagents, and follows the agents when it has", () => {
		const alone = widgetLines([], undefined, NOW, theme, 100, [], 24, [], [bash, timer]);
		expect(alone).toHaveLength(2);
		expect(alone[0]).toContain("bash-3");
		const team = [member("main-0001"), member("researcher-1a2b", { parentId: "main-0001" })];
		const both = widgetLines(team, "main-0001", NOW, theme, 100, [], 24, [], [bash, timer]);
		const agentAt = both.findIndex((line) => line.includes("researcher-1a2b"));
		const bashAt = both.findIndex((line) => line.includes("bash-3"));
		const timerAt = both.findIndex((line) => line.includes("#4"));
		expect(agentAt).toBeGreaterThan(0);
		expect(bashAt).toBeGreaterThan(agentAt);
		expect(timerAt).toBeGreaterThan(bashAt);
	});

	it("keeps the whole widget within a third of a short terminal, agents and work together", () => {
		const agents = ["a1f3", "b2e4", "c3d5"].map((hash) =>
			member(`researcher-${hash}`, { parentId: "main-0001", goal: "Investigate the flaky tests" }),
		);
		const work = Array.from({ length: 12 }, (_, index): WorkRow => ({ ...bash, id: `bash-${index + 1}` }));
		for (const terminalRows of [12, 24, 40]) {
			const lines = widgetLines(
				[member("main-0001"), ...agents],
				"main-0001",
				NOW,
				theme,
				80,
				[],
				terminalRows,
				[],
				work,
			);
			const budget = Math.max(3, Math.floor(terminalRows / 3));
			// The agents keep their three rows; the work block is bounded by what is left of the budget.
			expect(lines.length, `rows ${terminalRows}`).toBeLessThanOrEqual(Math.max(budget, 3 + Math.max(1, budget - 3)));
			expect(lines.join("\n")).toContain("more");
		}
		const only = widgetLines([], undefined, NOW, theme, 80, [], 24, [], work);
		expect(only).toHaveLength(8);
		expect(only.at(-1)).toContain("+5 more");
	});
});

describe("the worktree badge", () => {
	const main = member("main-0001", { status: "idle", checkout: "/repo" });
	const isolated = member("implementer-1a2b", {
		parentId: "main-0001",
		checkout: "/home/u/.octocode/worktrees/implementer-1a2b",
		branch: "octocode/implementer-1a2b",
		goal: "Add the typed view",
	});
	const plain = member("researcher-3c4d", { parentId: "main-0001", checkout: "/repo", goal: "Read the code" });

	it("marks an agent that works in another checkout, with its branch, and no other", () => {
		const lines = widgetLines([main, isolated, plain], "main-0001", NOW, theme, 200);
		const isolatedRow = lines.find((line) => line.includes("implementer-1a2b"))!;
		expect(isolatedRow).toContain("worktree ⎇ octocode/implementer-1a2b");
		expect(lines.find((line) => line.includes("researcher-3c4d"))).not.toContain("worktree");
	});

	it("marks an isolated child that joined the coordinator's team: same checkout, a working folder outside it", () => {
		const child = { ...isolated, checkout: "/repo", cwd: "/home/u/.octocode/worktrees/ab12/implementer-1a2b" };
		const peer = { ...plain, cwd: "/repo/packages/app" };
		const lines = widgetLines([main, child, peer], "main-0001", NOW, theme, 200);
		expect(lines.find((line) => line.includes("implementer-1a2b"))).toContain("worktree ⎇ octocode/implementer-1a2b");
		expect(lines.find((line) => line.includes("researcher-3c4d"))).not.toContain("worktree");
	});

	it("names the folder when the agent has no branch", () => {
		const detached = { ...isolated, branch: undefined };
		const row = widgetLines([main, detached], "main-0001", NOW, theme, 200).find((line) =>
			line.includes("implementer"),
		)!;
		expect(row).toContain(`worktree ${path.basename(detached.checkout!)}`);
	});

	it("keeps the word `worktree` when the branch no longer fits, and in the narrow and collapsed layouts", () => {
		for (const width of [70, 56, 44]) {
			const lines = widgetLines([main, isolated], "main-0001", NOW, theme, width);
			expect(lines.join("\n"), `width ${width}`).toContain("worktree");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		const entries = roster([main, isolated, plain], "main-0001", NOW, []).tree;
		const rows = collapsedRows(entries, NOW, theme, 80);
		expect(rows.find((line) => line.includes("implementer-1a2b"))).toContain("worktree");
		expect(rows.find((line) => line.includes("researcher-3c4d"))).not.toContain("worktree");
		// A short terminal collapses the agents to one row each: the badge survives there too.
		const short = widgetLines([main, isolated, plain], "main-0001", NOW, theme, 80, [], 9);
		expect(short.join("\n")).toContain("worktree");
	});
});

describe("typed counts and the footer", () => {
	it("counts by type, in a fixed order, and is empty when nothing runs", () => {
		expect(workCounts(0, [])).toBe("");
		expect(workCounts(1, [])).toBe("1 agent");
		expect(workCounts(2, [bash, bare, timer])).toBe("2 agents · 2 bash · 1 timer");
		expect(workCounts(0, [timer, external, bash])).toBe("1 bash · 1 timer · 1 external");
	});

	it("tells its listeners only when the rows differ", () => {
		const work = new RunningWork();
		let heard = 0;
		const stop = work.subscribe(() => heard++);
		work.set("bash", [bash]);
		work.set("bash", [{ ...bash }]);
		expect(heard).toBe(1);
		work.set("timer", [timer]);
		work.set("bash", []);
		work.set("bash", []);
		expect(heard).toBe(3);
		expect(work.all().map((row) => row.kind)).toEqual(["timer"]);
		stop();
		work.set("timer", []);
		expect(heard).toBe(3);
	});

	it("sets the footer's running status from the store, mounts the widget for work alone, and clears both at idle", () => {
		const f = fakeHost();
		const team = new Team(f.api, { OCTOCODE_AGENT_DB: path.join(tmp(), "none", "team.sqlite") });
		const ctx = fakeCtx({ cwd: tmp() });
		team.start(ctx);
		const work = new RunningWork();
		const view = new AgentsView(team, work);
		view.start(ctx);
		expect(ctx.ui.statuses.get("octocode-running")).toBeUndefined();
		expect(ctx.ui.widgets.has("octocode-agents")).toBe(false);
		work.set("bash", [bash]);
		work.set("timer", [timer]);
		view.setBackground(["general-1a2b"]);
		expect(ctx.ui.statuses.get("octocode-running")).toBe("1 agent · 1 bash · 1 timer");
		expect(ctx.ui.widgets.has("octocode-agents")).toBe(true);
		work.set("bash", []);
		expect(ctx.ui.statuses.get("octocode-running")).toBe("1 agent · 1 timer");
		work.set("timer", []);
		view.setBackground([]);
		expect(ctx.ui.statuses.get("octocode-running")).toBeUndefined();
		expect(ctx.ui.widgets.has("octocode-agents")).toBe(false);
		view.stop(ctx);
		team.stop();
	});

	it("repaints the widget when the work changes, and not when it is published unchanged", () => {
		const f = fakeHost();
		const team = new Team(f.api, { OCTOCODE_AGENT_DB: path.join(tmp(), "none", "team.sqlite") });
		const ctx = fakeCtx({ cwd: tmp() });
		team.start(ctx);
		const work = new RunningWork();
		const view = new AgentsView(team, work);
		view.start(ctx);
		work.set("bash", [bash]);
		let repaints = 0;
		const factory = ctx.ui.widgets.get("octocode-agents") as (
			tui: unknown,
			theme: unknown,
		) => {
			render(width: number): string[];
		};
		const component = factory({ requestRender: () => repaints++, terminal: { rows: 24 } }, theme);
		expect(component.render(100).join("\n")).toContain("bash-3");
		const before = repaints;
		work.set("bash", [{ ...bash }]);
		expect(repaints).toBe(before);
		work.set("timer", [timer]);
		expect(repaints).toBeGreaterThan(before);
		expect(component.render(100).join("\n")).toContain("#4");
		view.stop(ctx);
		team.stop();
	});
});

describe("timer rows", () => {
	const row = (extra: Partial<TimerRow>): TimerRow =>
		({
			id: 1,
			note: "check the build\nsecond line",
			kind: "once",
			due_at: NOW + 60_000,
			interval_ms: null,
			condition_kind: null,
			condition: null,
			max_runs: null,
			runs: 0,
			deadline_at: null,
			status: "active",
			created_at: NOW,
			...extra,
		}) as TimerRow;

	it("names the delay, the interval with its run, or the condition, with the note's first line and the time left", () => {
		const rows = timerWorkRows([
			row({ id: 3, kind: "every", interval_ms: 300_000, runs: 1, max_runs: 4, due_at: NOW + 120_000 }),
			row({ id: 2 }),
			row({
				id: 5,
				kind: "until",
				condition_kind: "command",
				condition: encodeCondition({ kind: "command", command: "nc -z localhost 5173" }),
				deadline_at: NOW + 3_600_000,
				due_at: NOW + 15_000,
			}),
			row({ id: 9, status: "done" }),
		]);
		expect(rows.map((r) => [r.id, r.title, r.detail, r.dueAt])).toEqual([
			["#2", "after 1m", "check the build", NOW + 60_000],
			["#3", "every 5m · run 2 of 4", "check the build", NOW + 120_000],
			["#5", "until `nc -z localhost 5173` exits 0", "check the build", NOW + 3_600_000],
		]);
		expect(rows.every((r) => r.kind === "timer")).toBe(true);
	});
});

describe("the work clock without motion", () => {
	const minutes = (work: WorkRow[]) => workRows(work, NOW, theme, 100, MARKS, undefined, false);

	it("shows whole minutes that stay true between minute repaints, and seconds when marks move", () => {
		const long: WorkRow = { ...bash, startedAt: NOW - 3 * 60_000 - 59_000 };
		expect(minutes([{ ...bare, startedAt: NOW - 12_000 }])[0]).toMatch(/<1m\s*$/);
		expect(minutes([long])[0]).toMatch(/3m\s*$/);
		// Time left rounds up: never less than remains.
		expect(minutes([{ ...timer, dueAt: NOW + 8 * 60_000 + 1_000 }])[0]).toMatch(/in 9m\s*$/);
		expect(minutes([{ ...timer, dueAt: NOW + 20_000 }])[0]).toMatch(/in <1m\s*$/);
		expect(minutes([{ ...timer, dueAt: NOW - 1 }])[0]).toMatch(/due\s*$/);
		expect(workRows([long], NOW, theme, 100, MARKS)[0]).toMatch(/3m59s\s*$/);
		const lines = widgetLines([], undefined, NOW, theme, 100, [], 24, [], [long], false);
		expect(lines[0]).toMatch(/3m\s*$/);
	});

	it("aims the next repaint at the minute boundary of the oldest row, and at nothing without a clock", () => {
		const old: WorkRow = { ...bash, startedAt: NOW - 10 * 60_000 - 20_000 };
		expect(nextMinuteDelay([old, bare], NOW)).toBe(40_000 + 50);
		expect(nextMinuteDelay([{ ...timer, dueAt: NOW + 90_000 }], NOW)).toBe(30_000 + 50);
		expect(nextMinuteDelay([unlisted], NOW)).toBeUndefined();
		expect(nextMinuteDelay([], NOW)).toBeUndefined();
	});
});

describe("repainting the work clock", () => {
	afterEach(() => {
		animationClock.setReducedMotion(false);
		vi.useRealTimers();
	});

	const setup = () => {
		vi.useFakeTimers({ now: NOW });
		const f = fakeHost();
		const team = new Team(f.api, { OCTOCODE_AGENT_DB: path.join(tmp(), "none", "team.sqlite") });
		const ctx = fakeCtx({ cwd: tmp() });
		team.start(ctx);
		const work = new RunningWork();
		const view = new AgentsView(team, work);
		view.start(ctx);
		let repaints = 0;
		const mountView = () => {
			const factory = ctx.ui.widgets.get("octocode-agents") as (
				tui: unknown,
				theme: unknown,
			) => { render(width: number): string[] };
			return factory({ requestRender: () => repaints++, terminal: { rows: 24 } }, theme);
		};
		return { work, view, team, ctx, mountView, repaints: () => repaints };
	};

	it("repaints every frame while a bash job and a timer run with the main agent idle: spinner, seconds, countdown; stops when they end", () => {
		const { work, view, team, ctx, mountView, repaints } = setup();
		work.set("bash", [{ ...bash, startedAt: NOW - 20_000 }]);
		work.set("timer", [{ ...timer, dueAt: NOW + 30_000 }]);
		const component = mountView();
		const frame = () => component.render(100).join("\n");
		expect(animationClock.isRunning()).toBe(true);
		expect(frame()).toMatch(/20s\s*$/m);
		expect(frame()).toMatch(/in 30s\s*$/m);
		const before = repaints();
		const first = frame().split("\n")[0];
		vi.advanceTimersByTime(3_000);
		expect(repaints()).toBeGreaterThan(before + 10);
		expect(frame()).toMatch(/23s\s*$/m);
		expect(frame()).toMatch(/in 27s\s*$/m);
		expect(frame().split("\n")[0].slice(0, 3)).not.toBe(first.slice(0, 3));
		work.set("bash", []);
		work.set("timer", []);
		expect(animationClock.isRunning()).toBe(false);
		const after = repaints();
		vi.advanceTimersByTime(5 * 60_000);
		expect(repaints()).toBe(after);
		view.stop(ctx);
		team.stop();
	});

	it("repaints once a minute in reduced motion while only a bash job runs, showing minutes, and stops when it ends", () => {
		animationClock.setReducedMotion(true);
		const { work, view, team, ctx, mountView, repaints } = setup();
		work.set("bash", [{ ...bash, startedAt: NOW - 20_000 }]);
		const component = mountView();
		expect(component.render(100).join("\n")).toMatch(/<1m/);
		const before = repaints();
		expect(animationClock.isRunning()).toBe(true);
		// No repaint inside the first 40 s (until the job's minute turns), then one at the boundary.
		vi.advanceTimersByTime(39_000);
		expect(repaints()).toBe(before);
		vi.advanceTimersByTime(2_000);
		expect(repaints()).toBe(before + 1);
		expect(component.render(100).join("\n")).toMatch(/1m\s*$/m);
		// Then one per minute, with no extra ones between.
		vi.advanceTimersByTime(3 * 60_000);
		expect(repaints()).toBe(before + 4);
		expect(component.render(100).join("\n")).toMatch(/4m\s*$/m);
		work.set("bash", []);
		expect(animationClock.isRunning()).toBe(false);
		const after = repaints();
		vi.advanceTimersByTime(5 * 60_000);
		expect(repaints()).toBe(after);
		view.stop(ctx);
		team.stop();
	});

	it("runs no clock in reduced motion for work without elapsed or remaining time, and none once idle", () => {
		animationClock.setReducedMotion(true);
		const { work, view, team, ctx, mountView, repaints } = setup();
		view.setBackground(["general-1a2b"]);
		mountView();
		expect(animationClock.isRunning()).toBe(false);
		const before = repaints();
		vi.advanceTimersByTime(5 * 60_000);
		expect(repaints()).toBe(before);
		work.set("timer", [{ ...timer, dueAt: NOW + 10 * 60_000 }]);
		expect(animationClock.isRunning()).toBe(true);
		work.set("timer", []);
		expect(animationClock.isRunning()).toBe(false);
		view.stop(ctx);
		team.stop();
	});
});

describe("the motion clock and the minute clock share one subscription", () => {
	afterEach(() => {
		animationClock.setReducedMotion(false);
		vi.useRealTimers();
	});

	it("shows seconds while a mark moves, whole minutes once it stills, and stops with nothing left", () => {
		vi.useFakeTimers({ now: NOW });
		let marks: Moving[] = [{ state: "running" }];
		let rows: WorkRow[] = [{ ...bare, startedAt: NOW }];
		let repaints = 0;
		const motion = new PanelMotion(
			() => marks,
			() => repaints++,
			(now) => nextMinuteDelay(rows, now),
		);
		motion.sync();
		expect(motion.precise).toBe(true);
		vi.advanceTimersByTime(1_000);
		expect(repaints).toBeGreaterThan(5);
		marks = [];
		vi.advanceTimersByTime(1_000);
		expect(motion.precise).toBe(false);
		expect(motion.active).toBe(true);
		const still = repaints;
		vi.advanceTimersByTime(30_000);
		expect(repaints).toBe(still);
		rows = [];
		vi.advanceTimersByTime(60_000);
		expect(motion.active).toBe(false);
		expect(animationClock.isRunning()).toBe(false);
		motion.dispose();
	});

	it("shows minutes in reduced motion, where the marks hold still", () => {
		vi.useFakeTimers({ now: NOW });
		animationClock.setReducedMotion(true);
		const rows: WorkRow[] = [{ ...bare, startedAt: NOW }];
		let repaints = 0;
		const motion = new PanelMotion(
			() => [{ state: "running" }],
			() => repaints++,
			(now) => nextMinuteDelay(rows, now),
		);
		motion.sync();
		expect(motion.precise).toBe(false);
		expect(motion.active).toBe(true);
		vi.advanceTimersByTime(61_000);
		expect(repaints).toBe(1);
		motion.dispose();
	});
});
