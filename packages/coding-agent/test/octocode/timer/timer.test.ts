import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, expire, leases, openDatabase, sessions, timers } from "../../../../db/src/api.ts";
import { registeredWorkspace } from "../../../src/config/workspace-database.ts";
import { TIMER_TYPE } from "../../../src/octocode/shared/messages.ts";
import { STATUS } from "../../../src/octocode/shared/status.ts";
import { conditionChecker } from "../../../src/octocode/timer/condition.ts";
import { type CheckOutcome, timerFields } from "../../../src/octocode/timer/model.ts";
import { sendCustomMessage } from "../../../src/core/agent-session/prompting.ts";
import { registerTimers } from "../../../src/octocode/timer/register.ts";
import { renderTimerMessage } from "../../../src/octocode/timer/render.ts";
import { TimerScheduler } from "../../../src/octocode/timer/scheduler.ts";
import { fakeCtx, fakeHost, rendered } from "../fake-host.ts";
import { tmp } from "../helpers.ts";

const T0 = Date.UTC(2026, 10, 5, 12);
let root: string;
let file: string;
let agent: AgentDb;
let workspaceId: string;
/** Schedulers a test started: the shared clock's interval must not outlive the fake timers it was made under. */
const started: TimerScheduler[] = [];
const open = () => openDatabase({ file, archiveDir: path.join(root, "archive"), privateParent: false });
const owner = (sessionId = "s1") => ({ workspaceId, sessionId, cwd: root });
const add = (input: Parameters<typeof timerFields>[0], sessionId = "s1", now = Date.now()) =>
	timers.insert(agent.db, timerFields(input, now, owner(sessionId)));

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"], now: T0 });
	root = tmp();
	file = path.join(root, "workspaces.db");
	agent = open();
	workspaceId = registeredWorkspace(root, agent).id;
});
afterEach(() => {
	for (const instance of started.splice(0)) instance.stop();
	vi.useRealTimers();
	agent.close();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("timers queries", () => {
	it("coalesces missed runs into one claim and moves to the next interval mark", () => {
		const timer = add({ note: "look", every: 60 });
		const now = T0 + 10.5 * 60_000;
		const claimed = timers.claim(agent.db, timer.id, "s1", now)!;
		expect(claimed.runs).toBe(1);
		expect(claimed.due_at).toBe(T0 + 11 * 60_000);
		expect(timers.claim(agent.db, timer.id, "s1", now)).toBeUndefined();
		expect(timers.claim(agent.db, timer.id, "other", T0 + 11 * 60_000)).toBeUndefined();
	});

	it("lets only one of two connections claim a fire", () => {
		const timer = add({ note: "once", after: 0 });
		const second = open();
		try {
			const claims = [agent, second].map((db) => timers.claim(db.db, timer.id, "s1", T0));
			expect(claims.filter(Boolean)).toHaveLength(1);
			expect(timers.get(agent.db, timer.id)).toMatchObject({ status: "done", stop_reason: "fired", runs: 1 });
		} finally {
			second.close();
		}
	});

	it("cancels only the owner's active timer, which then never fires", () => {
		const timer = add({ note: "x", after: 0 });
		expect(timers.cancel(agent.db, timer.id, "intruder", T0)).toBeUndefined();
		expect(timers.cancel(agent.db, timer.id, "s1", T0)).toMatchObject({ status: "cancelled" });
		expect(timers.claim(agent.db, timer.id, "s1", T0 + 1000)).toBeUndefined();
	});

	it("goes with its owner session: erased, or expired once the session's file is gone", () => {
		add({ note: "a", after: 60 }, "gone");
		add({ note: "b", after: 60 }, "stale");
		add({ note: "c", after: 60 }, "kept");
		expect(sessions.erase(agent.db, ["gone"]).timers).toBe(1);
		expect(expire.orphans(agent.db, ["stale"], T0 + 1).timers).toBe(1);
		expect(timers.forSession(agent.db, "kept")).toHaveLength(1);
	});

	it("retention drops ended and abandoned timers older than the cutoff", () => {
		const ended = add({ note: "ended", after: 0 });
		timers.cancel(agent.db, ended.id, "s1", T0);
		add({ note: "abandoned", after: 0 });
		const recent = add({ note: "recent", after: 0 }, "s1", T0 + 5000);
		expect(timers.purgeBefore(agent.db, T0 + 1000)).toBe(2);
		expect(timers.forSession(agent.db, "s1", true).map((row) => row.id)).toEqual([recent.id]);
	});
});

function scheduler(check: (calls: number) => CheckOutcome = () => ({ met: false, exit: 1, output: "" }), db = agent) {
	const woken: Array<ReturnType<typeof timers.get>> = [];
	let calls = 0;
	const instance = new TimerScheduler({
		db: () => db,
		sessionId: "s1",
		check: async () => check(++calls),
		wake: (row) => woken.push(row),
	});
	started.push(instance);
	instance.refresh();
	return { instance, woken, checks: () => calls };
}

describe("the timer scheduler", () => {
	it("fires a one-shot once with its note", async () => {
		add({ note: "check the build", after: 5 });
		const { instance, woken } = scheduler();
		await vi.advanceTimersByTimeAsync(4000);
		expect(woken).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(2000);
		expect(woken).toMatchObject([{ note: "check the build", status: "done" }]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(woken).toHaveLength(1);
		instance.stop();
	});

	it("stops a repeating timer at maxRuns", async () => {
		add({ note: "poll", every: 30, maxRuns: 3 });
		const { woken } = scheduler();
		await vi.advanceTimersByTimeAsync(200_000);
		expect(woken.map((row) => [row!.runs, row!.status])).toEqual([
			[1, "active"],
			[2, "active"],
			[3, "done"],
		]);
	});

	it("ends a repeating timer at its deadline, waking once more to say so", async () => {
		add({ note: "poll", every: 30, deadline: 70 });
		const { woken } = scheduler();
		await vi.advanceTimersByTimeAsync(200_000);
		expect(woken.map((row) => [row!.runs, row!.status, row!.stop_reason])).toEqual([
			[1, "active", null],
			[2, "expired", "deadline"],
		]);
	});

	it("checks an until condition silently and wakes once when it is met", async () => {
		add({ note: "build is green", until: { command: "true" }, every: 5 });
		const { woken, checks } = scheduler((n) => ({ met: n === 3, exit: n === 3 ? 0 : 1, output: `try ${n}` }));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(checks()).toBe(3);
		expect(woken).toMatchObject([{ status: "done", stop_reason: "met", last_exit: 0, last_output: "try 3" }]);
	});

	it("fails a timer whose check is refused, waking once", async () => {
		add({ note: "x", until: { command: "rm -rf build" }, every: 5 });
		const { woken } = scheduler(() => ({ met: false, exit: null, output: "", refused: "plan mode" }));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(woken).toMatchObject([{ status: "failed", stop_reason: "plan mode" }]);
	});

	it("fires a timer missed while no process held the session once on return", async () => {
		add({ note: "poll", every: 60 });
		const first = scheduler();
		first.instance.stop();
		vi.setSystemTime(T0 + 10 * 60_000 + 500);
		const second = scheduler();
		await vi.advanceTimersByTimeAsync(1000);
		expect(second.woken).toMatchObject([{ runs: 1, due_at: T0 + 11 * 60_000 }]);
		expect(first.woken).toHaveLength(0);
	});

	it("never fires a row twice from two processes on one session", async () => {
		add({ note: "once", after: 3 });
		const other = open();
		try {
			const a = scheduler(undefined, agent);
			const b = scheduler(undefined, other);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(a.woken.length + b.woken.length).toBe(1);
		} finally {
			other.close();
		}
	});

	it("wakes B once when A unlocks the path B waits for", async () => {
		const target = path.join(root, "src", "a.ts");
		leases.insert(
			agent.db,
			workspaceId,
			"agent-a",
			{ path: "src/a.ts", pathKey: target, kind: "file", reason: "editing" },
			T0,
			T0 + 3_600_000,
		);
		const check = conditionChecker({
			reservation: (absolute, display) =>
				leases.conflicting(agent.db, registeredWorkspace(root, agent).root, "agent-b", Date.now(), absolute, [], "file")
					? `${display} is reserved by agent-a`
					: undefined,
			context: () => undefined,
		});
		add({ note: "edit src/a.ts now", until: { unlocked: "src/a.ts" } });
		const woken: unknown[] = [];
		const waiting = new TimerScheduler({ db: () => agent, sessionId: "s1", check, wake: (row) => woken.push(row) });
		started.push(waiting);
		waiting.refresh();
		await vi.advanceTimersByTimeAsync(40_000);
		expect(woken).toHaveLength(0);
		expect(timers.forSession(agent.db, "s1")[0]).toMatchObject({ last_output: "src/a.ts is reserved by agent-a" });
		leases.releaseByOwner(agent.db, "agent-a");
		await vi.advanceTimersByTimeAsync(40_000);
		expect(woken).toMatchObject([{ note: "edit src/a.ts now", status: "done", stop_reason: "met" }]);
	});
});

describe("timer conditions", () => {
	it("runs an until-command on the bash path: exit 0 is met", async () => {
		vi.useRealTimers();
		const check = conditionChecker({ reservation: () => undefined, context: () => undefined });
		const flag = path.join(root, "ready");
		expect(await check({ kind: "command", command: `test -f ${flag}` }, root)).toMatchObject({ met: false, exit: 1 });
		fs.writeFileSync(flag, "");
		expect(await check({ kind: "command", command: `test -f ${flag} && echo ok` }, root)).toMatchObject({
			met: true,
			exit: 0,
			output: "ok\n",
		});
	});
});

describe("the timer tool in a session", () => {
	it("sets a timer that wakes the session with its note, and shows the count in the footer", async () => {
		const host = fakeHost();
		registerTimers(host.api, {
			reservation: () => undefined,
			agent: () => "me",
			env: { ...process.env, OCTOCODE_AGENT_DB: file },
		});
		const ctx = { ...fakeCtx({ cwd: root }), sessionManager: { getSessionId: () => "s1", getBranch: () => [] } };
		await host.fire("session_start", { reason: "startup" }, ctx);
		const tool = host.tools.get("timer");
		const set = await tool.execute(
			"call-1",
			{ op: "set", after: 2, note: "rerun the flaky test" },
			undefined,
			undefined,
			ctx,
		);
		expect(set.content[0].text).toMatch(/^Set \d+ · once/);
		expect(ctx.ui.statuses.get(STATUS.timers)).toBe("1 timer");
		await vi.advanceTimersByTimeAsync(3000);
		expect(host.sent).toHaveLength(1);
		const [{ message, options }] = host.sent;
		expect(message.customType).toBe(TIMER_TYPE);
		expect(message.content).toContain("Note: rerun the flaky test");
		expect(options).toMatchObject({ triggerTurn: true, deliverAs: "steer" });
		expect(ctx.ui.statuses.get(STATUS.timers)).toBeUndefined();
		const list = await tool.execute("call-2", { op: "list", all: true }, undefined, undefined, ctx);
		expect(list.content[0].text).toContain("done (fired)");
		await host.fire("session_shutdown", {}, ctx);
	});

	it("delivers a wake as a steer while a turn runs and starts a turn when idle", async () => {
		const host = fakeHost();
		registerTimers(host.api, {
			reservation: () => undefined,
			agent: () => "me",
			env: { ...process.env, OCTOCODE_AGENT_DB: file },
		});
		const ctx = { ...fakeCtx({ cwd: root }), sessionManager: { getSessionId: () => "s1", getBranch: () => [] } };
		await host.fire("session_start", { reason: "startup" }, ctx);
		await host.tools.get("timer").execute("c", { op: "set", after: 1, note: "wake me" }, undefined, undefined, ctx);
		await vi.advanceTimersByTimeAsync(2000);
		const [{ message, options }] = host.sent;
		const steer = vi.fn();
		const followUp = vi.fn();
		const startRun = vi.fn(async () => undefined);
		const session = (isStreaming: boolean) =>
			({
				session: { isStreaming, agent: { steer, followUp } },
				run: { isEmittingAgentSettled: false, deferredSettledActions: [] },
				inputs: { noteQueuedCustomMessage: vi.fn(), noteSteeredCustomMessage: vi.fn() },
				runLoop: { startRun },
			}) as never;
		await sendCustomMessage(session(true), message, options);
		expect(steer).toHaveBeenCalledOnce();
		expect(followUp).not.toHaveBeenCalled();
		expect(startRun).not.toHaveBeenCalled();
		await sendCustomMessage(session(false), message, options);
		expect(startRun).toHaveBeenCalledOnce();
		expect(steer).toHaveBeenCalledOnce();
		await host.fire("session_shutdown", {}, ctx);
	});

	it("holds a headless exit only for a timer set in this run, never for one loaded from an earlier run", async () => {
		add({ note: "from an earlier run", every: 60, maxRuns: 20 });
		add({ note: "waiting for a lock", until: { unlocked: "src/a.ts" } });
		const host = fakeHost();
		const timersHost = registerTimers(host.api, {
			reservation: () => "held",
			agent: () => undefined,
			env: { ...process.env, OCTOCODE_AGENT_DB: file },
		});
		const ctx = { ...fakeCtx({ cwd: root }), sessionManager: { getSessionId: () => "s1", getBranch: () => [] } };
		await host.fire("session_start", { reason: "resume" }, ctx);
		let settled = false;
		void timersHost.settle().then(() => (settled = true));
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(true);

		const tool = host.tools.get("timer");
		await tool.execute("c1", { op: "set", after: 20, note: "look again" }, undefined, undefined, ctx);
		settled = false;
		void timersHost.settle().then(() => (settled = true));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(11_000);
		expect(settled).toBe(true);
		expect(host.sent.map(({ message }) => message.content)).toEqual([expect.stringContaining("Note: look again")]);

		const set = await tool.execute("c2", { op: "set", after: 600, note: "later" }, undefined, undefined, ctx);
		settled = false;
		void timersHost.settle().then(() => (settled = true));
		await tool.execute("c3", { op: "cancel", id: set.details.timer.id }, undefined, undefined, ctx);
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(true);
		await host.fire("session_shutdown", {}, ctx);
	});

	it("refuses a repeating timer faster than the minimum and an eleventh active timer", async () => {
		expect(() => timerFields({ note: "x", every: 5 }, T0, owner())).toThrow(/at least 30 seconds/);
		for (let i = 0; i < 10; i++) add({ note: `t${i}`, after: 600 });
		const host = fakeHost();
		registerTimers(host.api, {
			reservation: () => undefined,
			agent: () => undefined,
			env: { ...process.env, OCTOCODE_AGENT_DB: file },
		});
		const ctx = { ...fakeCtx({ cwd: root }), sessionManager: { getSessionId: () => "s1", getBranch: () => [] } };
		await host.fire("session_start", { reason: "startup" }, ctx);
		await expect(
			host.tools.get("timer").execute("c", { op: "set", after: 1, note: "x" }, undefined, undefined, ctx),
		).rejects.toThrow(/10 active timers/);
		await host.fire("session_shutdown", {}, ctx);
	});
});

describe("the wake notice", () => {
	it("is drawn in the theme's warning colour with why it fired and the last result", () => {
		const colored = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => text,
		} as never;
		const details = {
			id: 7,
			kind: "until",
			status: "done",
			reason: "condition met: src/a.ts unlocked",
			note: "edit src/a.ts now",
			runs: 4,
			maxRuns: null,
			exit: null,
			output: "src/a.ts is not reserved.",
		};
		const text = rendered(renderTimerMessage(details, "", false, colored));
		expect(text).toContain("<warning>⏰ Timer 7: condition met: src/a.ts unlocked · done</warning>");
		expect(text).toContain("<warning>  edit src/a.ts now</warning>");
		expect(text).toContain("src/a.ts is not reserved.");
	});
});
