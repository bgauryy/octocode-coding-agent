import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, openDatabase, timers } from "../../../../db/src/api.ts";
import { registeredWorkspace } from "../../../src/storage/workspace-database.ts";
import { Subcommands } from "../../../src/octocode/shared/commands.ts";
import { runningWorkOf } from "../../../src/octocode/shared/running-work.ts";
import {
	CRON_EXPIRY_SECONDS,
	MIN_CRON_INTERVAL_MS,
	cronOf,
	jitterMs,
	nextMark,
	nextRunAt,
	parseCron,
	settledDue,
} from "../../../src/octocode/timer/cron.ts";
import { cronOverspend } from "../../../src/octocode/timer/cron-guard.ts";
import { loopSchedule } from "../../../src/octocode/timer/cron-command.ts";
import { MAX_ACTIVE, timerFields } from "../../../src/octocode/timer/model.ts";
import { registerTimers } from "../../../src/octocode/timer/register.ts";
import { TimerScheduler } from "../../../src/octocode/timer/scheduler.ts";
import { fakeCtx, fakeHost } from "../fake-host.ts";
import { tmp } from "../helpers.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Thursday 2026-11-05 12:00 UTC. */
const T0 = Date.UTC(2026, 10, 5, 12);
const utc = (iso: string) => Date.parse(iso);
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

let root: string;
let agent: AgentDb;
let workspaceId: string;
const started: TimerScheduler[] = [];
/** Sessions a test opened: their schedulers must stop before the faked clock goes, or the shared clock keeps a dead interval. */
const open: Array<() => Promise<unknown>> = [];

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"], now: T0 });
	root = tmp();
	agent = openDatabase({
		file: path.join(root, "workspaces.db"),
		mirrorFile: path.join(root, "transcripts.db"),
		archiveDir: path.join(root, "archive"),
		privateParent: false,
	});
	workspaceId = registeredWorkspace(root, agent).id;
});
afterEach(async () => {
	for (const close of open.splice(0)) await close();
	for (const each of started.splice(0)) each.stop();
	vi.useRealTimers();
	agent.close();
	fs.rmSync(root, { recursive: true, force: true });
});

const owner = { workspaceId: "", sessionId: "s1", cwd: "/" };
/** Inserts a cron timer of session `s1` and places its first run by its own id, as the tool does. */
function addCron(input: { cron: string; tz?: string; maxRuns?: number; deadline?: number }, now = T0) {
	const inserted = timers.insert(agent.db, timerFields({ note: "go", ...input }, now, { ...owner, workspaceId }));
	timers.reschedule(agent.db, inserted.id, settledDue(inserted, now));
	return timers.get(agent.db, inserted.id)!;
}

describe("next run of a schedule", () => {
	it("follows the zone across the clock change, month and weekend", () => {
		const weekdays = { expr: "0 9 * * 1-5", tz: "Europe/Paris" };
		// Summer time before 2026-10-25 (09:00 is 07:00 UTC), winter time after (08:00 UTC); Friday to Monday skips the weekend.
		expect(iso(nextMark(weekdays, utc("2026-10-22T08:00:00Z")))).toBe("2026-10-23T07:00:00.000Z");
		expect(iso(nextMark(weekdays, utc("2026-10-23T07:00:00Z")))).toBe("2026-10-26T08:00:00.000Z");
		expect(iso(nextMark({ expr: "0 9 1 * *", tz: "UTC" }, utc("2026-11-30T10:00:00Z")))).toBe(
			"2026-12-01T09:00:00.000Z",
		);
	});

	it("runs a time the clock skips once, just after the gap, and a repeated time once", () => {
		const newYork = { expr: "30 2 * * *", tz: "America/New_York" };
		expect(iso(nextMark(newYork, utc("2026-03-07T12:00:00Z")))).toBe("2026-03-08T07:00:00.000Z");
		expect(iso(nextMark(newYork, utc("2026-03-08T07:00:00Z")))).toBe("2026-03-09T06:30:00.000Z");
		const repeated = { expr: "30 1 * * *", tz: "America/New_York" };
		expect(iso(nextMark(repeated, utc("2026-10-31T12:00:00Z")))).toBe("2026-11-01T05:30:00.000Z");
		expect(iso(nextMark(repeated, utc("2026-11-01T05:30:00Z")))).toBe("2026-11-02T06:30:00.000Z");
	});
});

describe("what a schedule may be", () => {
	it("refuses anything but five numeric fields, a real zone and a date that exists", () => {
		expect(() => parseCron("0 0 9 * * *", undefined, T0)).toThrow();
		expect(() => parseCron("0 9 * * MON", undefined, T0)).toThrow();
		expect(() => parseCron("0 9 * * *", "Nowhere/City", T0)).toThrow();
		expect(() => parseCron("0 0 31 2 *", undefined, T0)).toThrow();
		expect(parseCron("0 9 * * 1-5", "UTC", T0)).toMatchObject({ expr: "0 9 * * 1-5", tz: "UTC" });
	});

	it("refuses a closest gap under the minimum, also when only some runs are close", () => {
		expect(() => parseCron("*/2 * * * *", undefined, T0)).toThrow();
		expect(() => parseCron("0,2 9 * * *", undefined, T0)).toThrow();
		expect(parseCron("*/5 * * * *", undefined, T0).expr).toBe("*/5 * * * *");
		expect(MIN_CRON_INTERVAL_MS).toBe(5 * MINUTE);
	});

	it("takes no other timing field and no zone alone", () => {
		expect(() => timerFields({ note: "n", cron: "0 9 * * *", every: 600 }, T0, { ...owner, workspaceId })).toThrow();
		expect(() => timerFields({ note: "n", tz: "UTC" }, T0, { ...owner, workspaceId })).toThrow();
	});

	it("expires after seven days unless the deadline says otherwise, and runs 20 times by default", () => {
		const row = addCron({ cron: "0 9 * * *", tz: "UTC" });
		expect(row.deadline_at).toBe(T0 + CRON_EXPIRY_SECONDS * 1000);
		expect(row.max_runs).toBe(20);
		expect(addCron({ cron: "0 9 * * *", deadline: 3600, maxRuns: 3 })).toMatchObject({
			deadline_at: T0 + HOUR,
			max_runs: 3,
		});
	});
});

describe("jitter", () => {
	it("is fixed per job, below half the period and 30 minutes, and none at the minimum period", () => {
		expect(jitterMs(7, 5 * MINUTE)).toBe(0);
		for (const id of [1, 2, 3, 4, 5, 99, 1234]) {
			expect(jitterMs(id, HOUR)).toBe(jitterMs(id, HOUR));
			expect(jitterMs(id, HOUR)).toBeLessThan(30 * MINUTE);
			expect(jitterMs(id, 10 * MINUTE)).toBeLessThan(5 * MINUTE);
			expect(jitterMs(id, 7 * DAY)).toBeLessThan(30 * MINUTE);
		}
		expect(new Set([1, 2, 3, 4, 5, 6].map((id) => jitterMs(id, DAY))).size).toBeGreaterThan(1);
	});

	it("places a new timer by the jitter of its own id and its later runs by the same", () => {
		const spec = { expr: "0 9 * * *", tz: "UTC" };
		const row = addCron({ cron: spec.expr, tz: spec.tz });
		const mark = nextMark(spec, T0)!;
		expect(row.due_at).toBe(mark + jitterMs(row.id, DAY));
		expect(nextRunAt(spec, row.id, row.due_at)).toBe(nextMark(spec, mark)! + jitterMs(row.id, DAY));
	});
});

/** A scheduler of session `s1` on the faked clock; its wakes are collected. */
function scheduler(
	woken: Array<{ id: number; status: string; stop: string | null }> = [],
	events: string[] = [],
	stop?: () => string | undefined,
) {
	const instance = new TimerScheduler({
		db: () => agent,
		sessionId: "s1",
		now: () => Date.now(),
		check: async () => ({ met: false, exit: null, output: "" }),
		wake: (row) => woken.push({ id: row.id, status: row.status, stop: row.stop_reason }),
		cronStop: stop ? () => stop() : undefined,
		cronEvent: (event) => events.push(event.kind),
	});
	started.push(instance);
	instance.refresh();
	return instance;
}

describe("runs missed while the session was not running", () => {
	const spec = { expr: "0 9 * * *", tz: "UTC" };
	it("fires once when resumed less than a period late, and moves to the next mark", async () => {
		const row = addCron({ cron: spec.expr, tz: spec.tz }, utc("2026-11-05T10:00:00Z"));
		const due = row.due_at;
		vi.setSystemTime(due + 12 * HOUR);
		const woken: Array<{ id: number; status: string; stop: string | null }> = [];
		const resumed = scheduler(woken);
		await resumed.tick();
		expect(woken).toEqual([{ id: row.id, status: "active", stop: null }]);
		const after = timers.get(agent.db, row.id)!;
		expect(after.runs).toBe(1);
		expect(after.due_at).toBe(nextRunAt(spec, row.id, due + 12 * HOUR));
		expect(after.due_at).toBeGreaterThan(due + 12 * HOUR);
	});

	it("skips the run, without a wake or a count, when more than one period late", async () => {
		const row = addCron({ cron: spec.expr, tz: spec.tz }, utc("2026-11-05T10:00:00Z"));
		vi.setSystemTime(row.due_at + 3 * DAY);
		const woken: Array<{ id: number; status: string; stop: string | null }> = [];
		const events: string[] = [];
		const resumed = scheduler(woken, events);
		await resumed.tick();
		expect(woken).toEqual([]);
		expect(events).toEqual(["skipped"]);
		const after = timers.get(agent.db, row.id)!;
		expect(after.runs).toBe(0);
		expect(after.status).toBe("active");
		expect(after.due_at).toBe(nextRunAt(spec, row.id, Date.now()));
	});

	it("survives a restart: a new scheduler reads the schedule from the row and fires on time", async () => {
		const row = addCron({ cron: spec.expr, tz: spec.tz }, utc("2026-11-05T10:00:00Z"));
		const first = scheduler();
		first.stop();
		vi.setSystemTime(row.due_at + 1000);
		const woken: Array<{ id: number; status: string; stop: string | null }> = [];
		const second = scheduler(woken);
		await second.tick();
		expect(woken).toHaveLength(1);
		expect(cronOf(timers.get(agent.db, row.id)!)).toMatchObject(spec);
	});
});

describe("the last run and the spending cap", () => {
	it("runs one last time when the next run falls after the expiry, then expires", async () => {
		const row = addCron({ cron: "0 9 * * *", tz: "UTC", deadline: 2 * 24 * 3600 }, utc("2026-11-05T10:00:00Z"));
		const woken: Array<{ id: number; status: string; stop: string | null }> = [];
		const instance = scheduler(woken);
		for (let day = 0; day < 4; day++) {
			vi.setSystemTime(timers.get(agent.db, row.id)!.due_at + 1000);
			await instance.tick();
		}
		expect(woken.at(-1)).toEqual({ id: row.id, status: "expired", stop: "deadline" });
		expect(woken.filter((each) => each.status === "active")).toHaveLength(woken.length - 1);
		expect(timers.get(agent.db, row.id)!.status).toBe("expired");
	});

	it("ends after maxRuns", async () => {
		const row = addCron({ cron: "*/5 * * * *", tz: "UTC", maxRuns: 2 });
		const woken: Array<{ id: number; status: string; stop: string | null }> = [];
		const instance = scheduler(woken);
		for (let run = 0; run < 3; run++) {
			vi.setSystemTime(timers.get(agent.db, row.id)!.due_at + 1000);
			await instance.tick();
		}
		expect(woken).toEqual([
			{ id: row.id, status: "active", stop: null },
			{ id: row.id, status: "done", stop: "maxRuns" },
		]);
	});

	it("stops a due run the cap refuses: failed with budget, no wake", async () => {
		const row = addCron({ cron: "*/5 * * * *", tz: "UTC" });
		const woken: Array<{ id: number; status: string; stop: string | null }> = [];
		const events: string[] = [];
		const instance = scheduler(woken, events, () => "budget");
		vi.setSystemTime(row.due_at + 1000);
		await instance.tick();
		expect(woken).toEqual([]);
		expect(events).toEqual(["stopped"]);
		expect(timers.get(agent.db, row.id)).toMatchObject({ status: "failed", stop_reason: "budget", runs: 0 });
	});

	it("counts spending from the oldest cron timer's recorded cost", () => {
		const rows = [addCron({ cron: "*/5 * * * *" })];
		expect(cronOverspend(rows, 1.5, 2)).toBeUndefined();
		expect(cronOverspend(rows, 2.01, 2)).toBeCloseTo(2.01);
		expect(cronOverspend([], 50, 2)).toBeUndefined();
	});
});

describe("a build that does not know cron", () => {
	it("reads the row as a slow every timer: its own claim advances at least the minimum", () => {
		const row = addCron({ cron: "*/5 * * * *", tz: "UTC" });
		expect(row.interval_ms).toBeGreaterThanOrEqual(MIN_CRON_INTERVAL_MS);
		const claimed = timers.claim(agent.db, row.id, "s1", row.due_at)!;
		expect(claimed.due_at - row.due_at).toBeGreaterThanOrEqual(MIN_CRON_INTERVAL_MS);
		const daily = addCron({ cron: "0 9 * * *", tz: "UTC" });
		expect(daily.interval_ms).toBe(DAY);
	});

	it("loads timers stored before cron existed as before", () => {
		const plain = timers.insert(agent.db, timerFields({ note: "n", every: 60 }, T0, { ...owner, workspaceId }));
		expect(plain.baseline).toBeNull();
		expect(cronOf(plain)).toBeUndefined();
		const listener = timers.insert(agent.db, {
			...timerFields({ note: "n", every: 60 }, T0, { ...owner, workspaceId }),
			baseline: "armed:0",
		});
		expect(cronOf(listener)).toBeUndefined();
	});
});

describe("/loop intervals", () => {
	it("turns an interval into an even cron step", () => {
		expect(loopSchedule(10, "m")).toEqual({ cron: "*/10 * * * *", every: "10m" });
		expect(loopSchedule(7, "m").cron).toBe("*/6 * * * *");
		expect(loopSchedule(2, "h").cron).toBe("0 */2 * * *");
		expect(loopSchedule(1, "d").cron).toBe("0 0 * * *");
		expect(loopSchedule(90, "m").cron).toBe("0 */2 * * *");
	});
});

/** A session with the timer tool and commands registered; `settings` is the global timer.cron block. */
async function session(
	options: { settings?: object; isSubagent?: boolean; hasUI?: boolean; confirms?: boolean[]; entries?: unknown[] } = {},
) {
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ timer: { cron: options.settings ?? {} } }));
	const host = fakeHost();
	const commands = new Subcommands();
	registerTimers(host.api, {
		reservation: () => undefined,
		agent: () => "me",
		env: { ...process.env, OCTOCODE_AGENT_DB: path.join(root, "workspaces.db") },
		agentDir,
		isSubagent: options.isSubagent === true,
		commands,
	});
	const entries = options.entries ?? [];
	const state = { idle: true };
	const ctx = {
		...fakeCtx({ cwd: root, hasUI: options.hasUI ?? true, ui: { confirms: options.confirms ?? [] } }),
		isIdle: () => state.idle,
		sessionManager: { getSessionId: () => "s1", getBranch: () => [], getEntries: () => entries },
	};
	await host.fire("session_start", { reason: "startup" }, ctx);
	open.push(() => host.fire("session_shutdown", {}, ctx));
	const tool = host.tools.get("notify");
	const set = (args: object) =>
		tool.execute("c", { op: "set", note: "check the build", ...args }, undefined, undefined, ctx);
	return { host, ctx, commands, set, tool, entries, state };
}

describe("setting a cron wait in a session", () => {
	it("confirms once per session when a screen exists, and a second schedule asks nothing", async () => {
		const { set, ctx } = await session({ confirms: [true] });
		const first = await set({ cron: "*/5 * * * *", tz: "UTC" });
		expect(first.content[0].text).toContain("Scheduled task");
		await set({ cron: "0 9 * * *", tz: "UTC" });
		expect(ctx.ui.confirms).toEqual([]);
		expect(timers.activeCount(agent.db, "s1")).toBe(2);
	});

	it("sets nothing when the user declines, and does not ask again", async () => {
		const { set } = await session({ confirms: [false, true] });
		await expect(set({ cron: "*/5 * * * *" })).rejects.toThrow();
		expect(timers.activeCount(agent.db, "s1")).toBe(0);
	});

	it("is refused without a screen unless timer.cron.enabled is on", async () => {
		const refused = await session({ hasUI: false });
		await expect(refused.set({ cron: "*/5 * * * *" })).rejects.toThrow();
		expect(timers.activeCount(agent.db, "s1")).toBe(0);
		const allowed = await session({ hasUI: false, settings: { enabled: true } });
		await allowed.set({ cron: "*/5 * * * *" });
		expect(timers.activeCount(agent.db, "s1")).toBe(1);
	});

	it("is refused in a subagent even with the setting on, while plain waits still work", async () => {
		const { set } = await session({ isSubagent: true, settings: { enabled: true } });
		await expect(set({ cron: "*/5 * * * *" })).rejects.toThrow();
		await set({ after: 60 });
		expect(timers.forSession(agent.db, "s1")).toHaveLength(1);
	});

	it("shares the cap of active timers with every other wait", async () => {
		const { set } = await session({ settings: { enabled: true } });
		for (let index = 0; index < MAX_ACTIVE; index++) await set({ after: 3600 });
		await expect(set({ cron: "*/5 * * * *" })).rejects.toThrow(String(MAX_ACTIVE));
	});

	it("shows the cron timer in the footer's work rows", async () => {
		const { set, host } = await session({ settings: { enabled: true } });
		await set({ cron: "0 9 * * 1-5", tz: "UTC" });
		expect(runningWorkOf(host.api).all()).toEqual([
			expect.objectContaining({
				kind: "timer",
				title: "cron 0 9 * * 1-5 UTC · run 1 of 20",
				detail: "check the build",
			}),
		]);
	});
});

describe("a cron run in a session", () => {
	const fire = async (host: ReturnType<typeof fakeHost>, row: { due_at: number }) => {
		await vi.advanceTimersByTimeAsync(Math.max(0, row.due_at - Date.now()) + 1500);
		void host;
	};

	it("is sent as a followUp while the session is busy, once however many marks pass, and again when idle", async () => {
		const { set, host, state } = await session({ settings: { enabled: true } });
		state.idle = false;
		await set({ cron: "*/5 * * * *", tz: "UTC" });
		const [row] = timers.forSession(agent.db, "s1");
		await fire(host, row);
		expect(host.sent).toHaveLength(1);
		expect(host.sent[0].options).toMatchObject({ triggerTurn: true, deliverAs: "followUp" });
		expect(host.sent[0].message.content).toContain("check the build");
		// Still busy: the marks that pass queue nothing behind the run that waits.
		await vi.advanceTimersByTimeAsync(10 * MINUTE);
		expect(host.sent).toHaveLength(1);
		expect(timers.get(agent.db, row.id)!.runs).toBe(3);
		// Idle: the next run is sent.
		state.idle = true;
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(host.sent).toHaveLength(2);
	});

	it("stops when the session spent more than the cap since the first schedule", async () => {
		const entries: unknown[] = [];
		const { set, host } = await session({ settings: { enabled: true, maxUsdPerSession: 1 }, entries });
		await set({ cron: "*/5 * * * *", tz: "UTC" });
		const [row] = timers.forSession(agent.db, "s1");
		entries.push({
			type: "message",
			message: {
				role: "assistant",
				provider: "p",
				model: "m",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.5 },
				},
			},
		});
		await fire(host, row);
		expect(host.sent).toHaveLength(0);
		expect(timers.get(agent.db, row.id)).toMatchObject({ status: "failed", stop_reason: "budget" });
	});
});

describe("/cron and /loop", () => {
	it("/loop adds a cron wait, /cron lists it and deletes it", async () => {
		const { commands, ctx } = await session();
		await commands.get("loop")!.handler("10m run the tests", ctx as never);
		const [row] = timers.forSession(agent.db, "s1");
		expect(cronOf(row)).toMatchObject({ expr: "*/10 * * * *" });
		expect(row.note).toBe("run the tests");
		await commands.get("cron")!.handler("list", ctx as never);
		expect(ctx.ui.notes.at(-1)!.message).toContain(`#${row.id} cron */10 * * * *`);
		await commands.get("cron")!.handler(`delete ${row.id}`, ctx as never);
		expect(timers.get(agent.db, row.id)!.status).toBe("cancelled");
		await commands.get("cron")!.handler("list", ctx as never);
		expect(ctx.ui.notes.at(-1)!.message).toContain("No scheduled tasks");
	});

	it("/cron delete leaves a wait that is not a cron schedule alone", async () => {
		const { commands, ctx, set } = await session();
		await set({ after: 3600 });
		const [row] = timers.forSession(agent.db, "s1");
		await commands.get("cron")!.handler(`delete ${row.id}`, ctx as never);
		expect(timers.get(agent.db, row.id)!.status).toBe("active");
		expect(ctx.ui.notes.at(-1)!.type).toBe("warning");
	});

	it("neither command exists in a subagent", async () => {
		const { commands } = await session({ isSubagent: true });
		expect(commands.has("cron")).toBe(false);
		expect(commands.has("loop")).toBe(false);
	});
});
