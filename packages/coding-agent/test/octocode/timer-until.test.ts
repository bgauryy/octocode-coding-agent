import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, openDatabase, timers } from "../../../db/src/api.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import type { ExtensionContext } from "../../src/core/features/index.ts";
import { runningWorkOf } from "../../src/octocode/shared/running-work.ts";
import { conditionChecker, conditionWatcher } from "../../src/octocode/timer/condition.ts";
import { parseUntil } from "../../src/octocode/timer/conditions/index.ts";
import type { ConditionDeps, TimerCondition } from "../../src/octocode/timer/conditions/types.ts";
import { CHECK_CAPS, Judge, type JudgeHost } from "../../src/octocode/timer/judge.ts";
import { timerFields, timerLine, wakeDetails, wakeText } from "../../src/octocode/timer/model.ts";
import { registerTimers } from "../../src/octocode/timer/register.ts";
import { TimerScheduler } from "../../src/octocode/timer/scheduler.ts";
import { untilCommand } from "../../src/octocode/shared/until-command.ts";
import { callSmallModel, smallModelLabel } from "../../src/octocode/subagents/small-call.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const T0 = Date.UTC(2026, 10, 6, 12);
let root: string;
let agent: AgentDb;
let workspaceId: string;
const started: TimerScheduler[] = [];

beforeEach(() => {
	root = tmp();
	agent = openDatabase({
		file: path.join(root, "workspaces.db"),
		archiveDir: path.join(root, "archive"),
		privateParent: false,
	});
	workspaceId = registeredWorkspace(root, agent).id;
});
afterEach(() => {
	for (const each of started.splice(0)) each.stop();
	vi.useRealTimers();
	agent.close();
	fs.rmSync(root, { recursive: true, force: true });
});

const judgeStub: ConditionDeps["judge"] = async () => ({ verdict: "skipped", reason: "none" });
const deps = (own: Partial<ConditionDeps> = {}): ConditionDeps => ({
	reservation: () => undefined,
	context: () => undefined,
	item: () => undefined,
	blockers: () => undefined,
	agentEnd: () => undefined,
	watchDatabase: () => () => undefined,
	judge: judgeStub,
	...own,
});
const check = (own?: Partial<ConditionDeps>) => conditionChecker(deps(own));
const owner = { workspaceId: "w", sessionId: "s1", cwd: "/" };

describe("the closed list of until conditions", () => {
	it("takes exactly one condition, named from the list", () => {
		expect(parseUntil({ command: " test -e a " })).toEqual({ kind: "command", command: "test -e a" });
		expect(parseUntil({ unlocked: "src/a.ts" })).toEqual({ kind: "unlocked", path: "src/a.ts" });
		expect(parseUntil({ item: { ref: "B1", state: "done" } })).toMatchObject({ kind: "item" });
		expect(parseUntil({ agent: { name: "ui" } })).toMatchObject({ kind: "agent" });
		expect(() => parseUntil({ job: "x" })).toThrow(/no condition job/);
		expect(() => parseUntil({ message: "x" })).toThrow(/no condition message/);
		expect(() => parseUntil({})).toThrow(/exactly one/);
		expect(() => parseUntil({ command: "true", unlocked: "a" })).toThrow(/exactly one/);
		expect(() => parseUntil({ item: { ref: "B1", state: "done", glob: "*" } })).toThrow(/no field glob/);
		expect(() => parseUntil({ item: { ref: "B1", state: "lost" } })).toThrow(/until.item.state/);
		expect(() => parseUntil({ item: { ref: " ", state: "done" } })).toThrow(/until.item.ref/);
		expect(parseUntil({ item: { ref: "B1", state: "done" } })).toEqual({ kind: "item", ref: "B1", state: "done" });
	});

	it("refuses the removed file and port conditions with the command that replaces each", () => {
		expect(() => parseUntil({ file: { path: "out.txt", is: "exists" } })).toThrow(
			"until.file was removed; set the timer with until.command instead: test -e out.txt",
		);
		expect(() => parseUntil({ file: { path: "my out.txt", is: "absent" } })).toThrow("test ! -e 'my out.txt'");
		expect(() => parseUntil({ file: { path: "log.txt" } })).toThrow(/until\.file was removed.*test log\.txt -nt mark/);
		expect(() => parseUntil({ port: { port: 5173 } })).toThrow(
			"until.port was removed; set the timer with until.command instead: nc -z localhost 5173",
		);
		expect(() => parseUntil({ port: { port: 80, host: "127.0.0.1" } })).toThrow("nc -z 127.0.0.1 80");
		// Malformed values still name the replacement, as does a check whose trigger is a removed kind.
		expect(() => parseUntil({ file: "a" })).toThrow("test path -nt mark");
		expect(() => parseUntil({ check: "up?", port: { port: 3000 } })).toThrow("nc -z localhost 3000");
		expect(() => parseUntil({ command: "true", file: { path: "a" } })).toThrow(/until\.file was removed/);
	});

	it("check names one trigger from the same list and cannot nest", () => {
		const parsed = parseUntil({ check: "done?", command: "test -e a" });
		expect(parsed).toMatchObject({ kind: "check", question: "done?", on: { kind: "command" } });
		expect(() => parseUntil({ check: "x" })).toThrow(/trigger condition/);
		expect(() => parseUntil({ check: "x", command: "true", unlocked: "a" })).toThrow(/exactly one/);
	});

	it("stores each kind and reads it back from the row", () => {
		const item = timerFields({ note: "n", until: { item: { ref: "B1", state: "done" } } }, T0, { ...owner, cwd: root });
		expect(item.condition).toEqual({ kind: "item", value: expect.any(String), cwd: root });
		expect(item.intervalMs).toBe(60_000);
		const row = timers.insert(agent.db, { ...item, workspaceId });
		expect(timerLine(row, T0)).toContain("B1 is done");
		expect(timerLine(row, T0)).toContain("watching");
		const command = timerFields({ note: "n", until: { command: "test -e a.txt" } }, T0, owner);
		expect(command.intervalMs).toBe(15_000);
		expect(timerLine(timers.insert(agent.db, { ...command, workspaceId }), T0)).toContain(
			"until `test -e a.txt` exits 0 · next check in 0s (polling every 15s)",
		);
	});
});

describe("deterministic conditions", () => {
	it("a command replaces the removed file and port waits: it is met when it exits 0", async () => {
		const run = (command: string) => check()({ kind: "command", command }, { cwd: root });
		expect(await run("test -e out.txt")).toMatchObject({ met: false, exit: 1 });
		expect(await run("test ! -e out.txt")).toMatchObject({ met: true, exit: 0 });
		fs.writeFileSync(path.join(root, "out.txt"), "x");
		expect(await run("test -e out.txt")).toMatchObject({ met: true, exit: 0 });
	});

	it("item with several refs fires when any reaches the state and names it", async () => {
		const input = { cwd: root };
		const states: Record<string, string> = { B1: "ongoing", B2: "done" };
		const parsed = parseUntil({ item: { ref: ["B1", "B2"], state: "done" } });
		expect(parsed).toEqual({ kind: "item", ref: "B1,B2", state: "done" });
		expect(parseUntil({ item: { ref: "B1, B2 B1", state: "done" } })).toEqual(parsed);
		expect(await check({ item: (ref) => states[ref] })(parsed!, input)).toMatchObject({
			met: true,
			output: "B1 is ongoing. B2 is done.",
		});
		states.B2 = "todo";
		expect(await check({ item: (ref) => states[ref] })(parsed!, input)).toMatchObject({ met: false });
		expect(
			await check({ item: (ref) => states[ref] })({ kind: "item", ref: "B1,B9", state: "done" }, input),
		).toMatchObject({
			refused: expect.stringContaining("no backlog item B9"),
		});
	});

	it("item state ready fires once every dependsOn item is done or closed", async () => {
		const input = { cwd: root };
		const ready = parseUntil({ item: { ref: "B5", state: "ready" } })!;
		let open = ["B2", "B3"];
		const host = { item: () => "todo", blockers: () => open };
		expect(await check(host)(ready, input)).toMatchObject({ met: false, output: "B5 waits on B2, B3." });
		open = ["B3"];
		expect(await check(host)(ready, input)).toMatchObject({ met: false });
		open = [];
		expect(await check(host)(ready, input)).toMatchObject({
			met: true,
			output: expect.stringContaining("B5 is ready"),
		});
	});

	it("item, agent and unlocked read the host", async () => {
		const item = { kind: "item", ref: "B12", state: "done" } as const;
		const input = { cwd: root };
		expect(await check({ item: () => "ongoing" })(item, input)).toMatchObject({ met: false });
		expect(await check({ item: () => "done" })(item, input)).toMatchObject({ met: true });
		expect(await check()(item, input)).toMatchObject({ refused: expect.stringContaining("no backlog item B12") });
		const agentCondition = { kind: "agent", name: "ui" } as const;
		expect(await check()(agentCondition, input)).toMatchObject({ met: false });
		expect(await check({ agentEnd: () => ({ reason: "completed" }) })(agentCondition, input)).toMatchObject({
			met: true,
			output: "ui ended: completed",
		});
		const held = check({ reservation: () => "src/a.ts is reserved by b" });
		expect(await held({ kind: "unlocked", path: "src/a.ts" }, input)).toMatchObject({ met: false });
	});
});

describe("event sources only poke a check", () => {
	const watched = (
		until: unknown,
		watch: ReturnType<typeof conditionWatcher>,
		scheduleDeps: Partial<ConditionDeps> = {},
	) => {
		const row = timers.insert(agent.db, {
			...timerFields({ note: "n", until, every: 60 }, Date.now(), { ...owner, workspaceId, cwd: root }),
		});
		const woken: unknown[] = [];
		const instance = new TimerScheduler({
			db: () => agent,
			sessionId: "s1",
			check: check(scheduleDeps),
			watch,
			wake: (each) => woken.push(each),
		});
		started.push(instance);
		instance.refresh();
		return { row, woken, instance };
	};

	it("wakes on a database event long before the safety poll", async () => {
		let state = "todo";
		let changed: () => void = () => undefined;
		const own: Partial<ConditionDeps> = {
			item: () => state,
			watchDatabase: (poke) => {
				changed = poke;
				return () => undefined;
			},
		};
		const { row, woken } = watched({ item: { ref: "B1", state: "done" } }, conditionWatcher(deps(own)), own);
		// The first check is due at once and finds nothing: the next one is a minute away.
		await vi.waitFor(() => expect(timers.get(agent.db, row.id)!.due_at).toBeGreaterThan(Date.now() + 30_000), {
			timeout: 4000,
		});
		state = "done";
		changed();
		await vi.waitFor(() => expect(woken).toHaveLength(1), { timeout: 4000 });
		expect(woken[0]).toMatchObject({ status: "done", stop_reason: "met" });
	});

	it("a quiet poke checks but writes nothing; a met one claims the row", async () => {
		let state = "todo";
		let poke: () => void = () => undefined;
		const watch = (_c: TimerCondition, _cwd: string, onPoke: () => void) => {
			poke = onPoke;
			return () => undefined;
		};
		const { row, woken } = watched({ item: { ref: "B1", state: "done" } }, watch, { item: () => state });
		const before = timers.get(agent.db, row.id)!;
		poke();
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(timers.get(agent.db, row.id)).toEqual(before);
		state = "done";
		poke();
		await vi.waitFor(() => expect(woken).toHaveLength(1), { timeout: 3000 });
	});

	it("a dead watcher brings the next check forward to the polling interval, and stop unsubscribes", () => {
		vi.useFakeTimers({ now: T0 });
		const stop = vi.fn();
		let failed: () => void = () => undefined;
		const watch = (_c: TimerCondition, _cwd: string, _poke: () => void, onFail: () => void) => {
			failed = onFail;
			return stop;
		};
		const { row, instance } = watched({ item: { ref: "B1", state: "done" } }, watch);
		failed();
		expect(timers.get(agent.db, row.id)!.due_at).toBe(T0 + 15_000);
		instance.stop();
		expect(stop).toHaveBeenCalledOnce();
	});

	it("cancelling a timer unsubscribes its watcher", () => {
		const stop = vi.fn();
		const { row, instance } = watched({ item: { ref: "B1", state: "done" } }, () => stop);
		timers.cancel(agent.db, row.id, "s1", Date.now());
		instance.refresh();
		expect(stop).toHaveBeenCalledOnce();
	});
});

/** A session whose cheaper model answers with the scripted replies. */
function judging(replies: Array<string | Error>, cost = 0.002) {
	const model = (id: string, input: number) => ({
		provider: "p",
		id,
		api: "faux",
		cost: { input, output: input, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		input: ["text"],
	});
	const parent = model("big", 15);
	const ctx = {
		model: parent,
		modelRegistry: {
			getAvailable: () => [parent, model("cheap", 1)],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
		},
	} as unknown as ExtensionContext;
	const complete = vi.fn(async () => {
		const next = replies.shift();
		if (next instanceof Error) throw next;
		const message = fauxAssistantMessage(next ?? "{}");
		message.usage = { ...message.usage, cost: { ...message.usage.cost, total: cost } };
		return message;
	});
	let now = T0;
	const spent = { session: 0 };
	const recorded: Array<Parameters<JudgeHost["recordUsage"]>> = [];
	const host: JudgeHost = {
		ctx: () => ctx,
		now: () => now,
		sessionSpend: () => spent.session,
		allowed: () => true,
		recordUsage: (...args) => {
			recorded.push(args);
		},
		small: {
			call: (ctx, options) => callSmallModel(ctx, { ...options, complete }),
			label: smallModelLabel,
		},
	};
	return {
		judge: new Judge(host),
		complete,
		recorded,
		spent,
		ctx,
		host,
		advance: (ms: number) => (now += ms),
	};
}
const ask = (over: Partial<Parameters<Judge["judge"]>[0]> = {}) => ({
	id: 1,
	sessionId: "s1",
	question: "Does the log show the migration finished?",
	trigger: "log.txt changed",
	evidence: "line 1",
	checks: 0,
	spentUsd: 0,
	...over,
});
const verdict = (v: string, reason = "because") => JSON.stringify({ verdict: v, reason });

describe("the agentic check", () => {
	it("makes no model call while its trigger has not fired", async () => {
		const j = judging([verdict("met")]);
		const outcome = await check({ item: () => "todo", judge: (r) => j.judge.judge(r) })(
			parseUntil({ check: "q", item: { ref: "B1", state: "done" } })!,
			{ cwd: root, row: { id: 1, checks: 0, spentUsd: 0, sessionId: "s1" } },
		);
		expect(outcome).toMatchObject({ met: false });
		expect(outcome.spend).toBeUndefined();
		expect(j.complete).not.toHaveBeenCalled();
	});

	it("judges once the trigger fires, with the evidence as quoted untrusted data, and reports the spend", async () => {
		const j = judging([verdict("met", "migration finished")]);
		const outcome = await check({ item: () => "done", judge: (r) => j.judge.judge(r) })(
			parseUntil({ check: "q?", item: { ref: "B1", state: "done" } })!,
			{ cwd: root, row: { id: 1, checks: 0, spentUsd: 0, sessionId: "s1" } },
		);
		expect(outcome).toMatchObject({
			met: true,
			spend: { calls: 1, usd: 0.002 },
			output: "Judged met by p/cheap: migration finished",
		});
		const call = j.complete.mock.calls[0] as unknown as [
			unknown,
			{ messages: Array<{ content: Array<{ text: string }> }> },
			{ maxTokens: number },
		];
		expect(call[1].messages[0].content[0].text).toMatch(/untrusted data[\s\S]*<evidence>\nB1 is done\.\n<\/evidence>/);
		expect(call[2].maxTokens).toBe(CHECK_CAPS.maxTokens);
	});

	it("caps the evidence at 6000 characters and keeps its end", async () => {
		const j = judging([verdict("not_met")]);
		await j.judge.judge(ask({ evidence: `${"a".repeat(7000)}TAIL` }));
		const text = (
			j.complete.mock.calls[0] as unknown as [unknown, { messages: Array<{ content: Array<{ text: string }> }> }]
		)[1].messages[0].content[0].text;
		expect(text).toContain("TAIL");
		expect(text.match(/a+/g)!.sort((x, y) => y.length - x.length)[0].length).toBeLessThanOrEqual(6000);
	});

	it("does not judge the same evidence twice, and keeps 30 s between judgments", async () => {
		const j = judging([verdict("not_met"), verdict("not_met"), verdict("not_met")]);
		expect((await j.judge.judge(ask())).verdict).toBe("not_met");
		expect(await j.judge.judge(ask({ checks: 1, spentUsd: 0.002 }))).toMatchObject({
			verdict: "skipped",
			reason: expect.stringContaining("unchanged"),
		});
		j.advance(10_000);
		expect(await j.judge.judge(ask({ evidence: "line 2", checks: 1 }))).toMatchObject({
			verdict: "skipped",
			reason: expect.stringContaining("30s apart"),
		});
		j.advance(30_000);
		expect((await j.judge.judge(ask({ evidence: "line 2", checks: 1 }))).verdict).toBe("not_met");
		expect(j.complete).toHaveBeenCalledTimes(2);
	});

	it("treats a reply that is not the JSON verdict as unsure", async () => {
		const j = judging(["I think it is done", verdict("maybe")]);
		expect(await j.judge.judge(ask())).toMatchObject({ verdict: "unsure" });
		j.advance(60_000);
		expect(await j.judge.judge(ask({ evidence: "x" }))).toMatchObject({ verdict: "unsure" });
	});

	it("ends the wait at 5 judgments or $0.05, naming the spend", async () => {
		const j = judging([]);
		expect(await j.judge.judge(ask({ checks: 5, spentUsd: 0.01 }))).toMatchObject({
			verdict: "stop",
			reason: expect.stringMatching(/^check budget: 5 judgments/),
		});
		expect(await j.judge.judge(ask({ checks: 2, spentUsd: 0.05 }))).toMatchObject({
			verdict: "stop",
			reason: expect.stringContaining("$0.0500"),
		});
		expect(j.complete).not.toHaveBeenCalled();
		// The fifth judgment that is not met ends the wait at once.
		const last = judging([verdict("not_met", "still going")]);
		expect(await last.judge.judge(ask({ checks: 4, spentUsd: 0.008 }))).toMatchObject({
			verdict: "stop",
			reason: expect.stringContaining("still going"),
			spend: { calls: 1 },
		});
	});

	it("ends the wait when one judgment costs more than $0.01, and at the $0.25 session cap", async () => {
		const dear = judging([verdict("met")], 0.02);
		expect(await dear.judge.judge(ask())).toMatchObject({
			verdict: "stop",
			reason: expect.stringContaining("over the $0.0100 cap"),
			spend: { usd: 0.02 },
		});
		const full = judging([]);
		full.spent.session = 0.25;
		expect(await full.judge.judge(ask())).toMatchObject({
			verdict: "stop",
			reason: expect.stringContaining("this session"),
		});
		expect(full.complete).not.toHaveBeenCalled();
	});

	it("skips a failed call once, and ends the wait at the second failure in a row", async () => {
		const j = judging([new Error("boom"), new Error("boom")]);
		expect(await j.judge.judge(ask())).toMatchObject({ verdict: "skipped" });
		j.advance(60_000);
		expect(await j.judge.judge(ask())).toMatchObject({ verdict: "stop", reason: expect.stringContaining("2 times") });
	});

	it("is off unless allowed", async () => {
		const j = judging([]);
		const off = new Judge({ ...j.host, allowed: () => false });
		expect(await off.judge(ask())).toMatchObject({
			verdict: "stop",
			reason: expect.stringContaining("timer.check.enabled"),
		});
		expect(j.complete).not.toHaveBeenCalled();
	});

	const watchUntil = (own: Partial<ConditionDeps>) => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"], now: T0 });
		const until = { check: "q", agent: { name: "ui" } };
		const row = timers.insert(
			agent.db,
			timerFields({ note: "n", until, every: 30 }, T0, { ...owner, workspaceId, cwd: root }),
		);
		const woken: Array<NonNullable<ReturnType<typeof timers.get>>> = [];
		const instance = new TimerScheduler({
			db: () => agent,
			sessionId: "s1",
			now: Date.now,
			check: check(own),
			wake: (each) => woken.push(each),
		});
		started.push(instance);
		instance.refresh();
		return { row, woken };
	};
	const pass = async (j: ReturnType<typeof judging>, times: number, until: () => boolean = () => false) => {
		for (let i = 0; i < times && !until(); i++) {
			j.advance(31_000);
			await vi.advanceTimersByTimeAsync(31_000);
		}
	};

	it("through a scheduler, unchanged evidence costs one judgment and then nothing", async () => {
		const j = judging([verdict("not_met", "no")], 0.004);
		const { row } = watchUntil({ agentEnd: () => ({ reason: "completed" }), judge: (r) => j.judge.judge(r) });
		await pass(j, 8);
		expect(j.complete).toHaveBeenCalledTimes(1);
		expect(timers.get(agent.db, row.id)).toMatchObject({ status: "active", checks: 1, spent_usd: 0.004 });
	});

	it("ends a spent wait failed with 'check budget', and each judgment was recorded in the session cost once", async () => {
		const j = judging(
			Array.from({ length: 6 }, () => verdict("unsure", "cannot tell")),
			0.009,
		);
		let n = 0;
		const { woken } = watchUntil({
			agentEnd: () => ({ reason: `r${n++}` }),
			judge: (r) => j.judge.judge(r),
		});
		await pass(j, 12, () => woken.length > 0);
		expect(woken).toHaveLength(1);
		const ended = woken[0];
		expect(ended).toMatchObject({ status: "failed" });
		expect(ended.stop_reason).toMatch(/^check budget/);
		expect(ended.checks).toBe(5);
		expect(ended.spent_usd).toBeCloseTo(0.045, 6);
		expect(j.recorded).toHaveLength(5);
		expect(j.recorded.reduce((sum, call) => sum + call[3].cost.total, 0)).toBeCloseTo(0.045, 6);
		expect(wakeDetails(ended)).not.toHaveProperty("usage");
	});

	it("wakes met with the model named and a note to verify", async () => {
		const j = judging([verdict("met", "all steps ran")], 0.003);
		const { woken } = watchUntil({ agentEnd: () => ({ reason: "completed" }), judge: (r) => j.judge.judge(r) });
		await pass(j, 4, () => woken.length > 0);
		expect(woken[0]).toMatchObject({
			status: "done",
			stop_reason: "met",
			checks: 1,
			last_output: "Judged met by p/cheap: all steps ran",
		});
		expect(wakeText(woken[0])).toContain(
			"A small model judged this (1 judgment, $0.0030): verify before relying on it.",
		);
	});
});

describe("the timer tool and check", () => {
	const session = (ctxOptions: { hasUI?: boolean } = {}, extra: Record<string, unknown> = {}) => {
		const host = fakeHost();
		const agentDir = path.join(root, "agent-home");
		fs.mkdirSync(agentDir, { recursive: true });
		const j = judging([verdict("met", "ok")]);
		registerTimers(host.api, {
			reservation: () => undefined,
			agent: () => "me",
			env: { ...process.env, OCTOCODE_AGENT_DB: path.join(root, "workspaces.db") },
			agentDir,
			small: j.host.small,
		});
		const ctx = {
			...fakeCtx({ cwd: root, ...ctxOptions }),
			model: j.ctx.model,
			modelRegistry: j.ctx.modelRegistry,
			sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
			...extra,
		};
		return { host, ctx, agentDir, j };
	};
	const set = (host: ReturnType<typeof fakeHost>, ctx: unknown, until: unknown) =>
		host.tools.get("timer").execute("c", { op: "set", note: "n", until }, undefined, undefined, ctx);
	const checkUntil = { check: "done?", command: "test -e x.txt" };

	it("refuses a check while it is off and nobody can be asked", async () => {
		const { host, ctx } = session({ hasUI: false });
		await host.fire("session_start", { reason: "startup" }, ctx);
		await expect(set(host, ctx, checkUntil)).rejects.toThrow(/timer.check.enabled/);
		expect(timers.activeCount(agent.db, "s1")).toBe(0);
		await host.fire("session_shutdown", {}, ctx);
	});

	it("asks once on first use, then allows checks for the session; a no declines", async () => {
		const declined = session();
		declined.ctx.ui.confirms.push(false);
		await declined.host.fire("session_start", { reason: "startup" }, declined.ctx);
		await expect(set(declined.host, declined.ctx, checkUntil)).rejects.toThrow(/declined/);
		await declined.host.fire("session_shutdown", {}, declined.ctx);

		const { host, ctx } = session();
		ctx.ui.confirms.push(true);
		await host.fire("session_start", { reason: "startup" }, ctx);
		const first = await set(host, ctx, checkUntil);
		expect(first.content[0].text).toMatch(/Judging is capped: 5 judgments and \$0\.05 per wait/);
		expect(ctx.ui.confirms).toHaveLength(0);
		const second = await set(host, ctx, checkUntil);
		expect(second.content[0].text).toContain("Judging is capped");
		await host.fire("session_shutdown", {}, ctx);
	});

	it("does not ask when the global setting turns it on, and a project setting cannot", async () => {
		const { host, ctx, agentDir } = session();
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ timer: { check: { enabled: true } } }));
		await host.fire("session_start", { reason: "startup" }, ctx);
		await set(host, ctx, checkUntil);
		expect(ctx.ui.confirms).toHaveLength(0);
		await host.fire("session_shutdown", {}, ctx);
	});

	it("refuses a check when no cheaper model exists", async () => {
		const { host, ctx, agentDir } = session();
		fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ timer: { check: { enabled: true } } }));
		const only = { ...ctx, modelRegistry: { ...ctx.modelRegistry, getAvailable: () => [ctx.model] } };
		await host.fire("session_start", { reason: "startup" }, only);
		await expect(set(host, only, checkUntil)).rejects.toThrow(/cheaper model/);
		await host.fire("session_shutdown", {}, only);
	});

	it("sets deterministic waits with no ask, and shows spend in the footer once a check spent", async () => {
		const { host, ctx } = session();
		await host.fire("session_start", { reason: "startup" }, ctx);
		await set(host, ctx, { unlocked: "x.txt" });
		await set(host, ctx, { command: "nc -z localhost 5173" });
		expect(ctx.ui.confirms).toHaveLength(0);
		expect(
			runningWorkOf(host.api)
				.all()
				.map((row) => row.title),
		).toEqual(["until x.txt unlocked", "until `nc -z localhost 5173` exits 0"]);
		const row = timers.forSession(agent.db, "s1")[0];
		timers.recordResult(agent.db, row.id, { exit: null, output: "", spend: { calls: 1, usd: 0.003 } }, Date.now());
		const list = await host.tools.get("timer").execute("l", { op: "list" }, undefined, undefined, ctx);
		expect(list.content[0].text).toContain("watching");
		expect(list.content[0].text).toContain("polling every 15s");
		await host.fire("session_shutdown", {}, ctx);
	});

	it("declares no file or port condition, and refuses a call that sends one before the schema does", async () => {
		const { host } = session();
		const tool = host.tools.get("timer");
		expect(Object.keys(tool.parameters.properties.until.properties).sort()).toEqual(
			["agent", "check", "command", "item", "unlocked"].sort(),
		);
		expect(tool.description).toContain("`test -e path`");
		expect(tool.description).toContain("`nc -z localhost 3000`");
		const call = (until: unknown) => () => tool.prepareArguments({ op: "set", note: "n", reason: "r", until });
		expect(call({ file: { path: "build.done", is: "exists" } })).toThrow(
			"until.file was removed; set the timer with until.command instead: test -e build.done",
		);
		expect(call({ port: { port: 3000 } })).toThrow("nc -z localhost 3000");
		const kept = { op: "set", note: "n", until: { command: "test -e build.done" } };
		expect(tool.prepareArguments(kept)).toBe(kept);
		expect(tool.prepareArguments({ op: "list" })).toEqual({ op: "list" });
	});
});

describe("gates see a command wherever until carries it", () => {
	it("reads the command of a plain until and of a check's trigger", () => {
		expect(untilCommand({ until: { command: "test -f a" } })).toBe("test -f a");
		expect(untilCommand({ until: { check: "q", command: "make -q" } })).toBe("make -q");
		expect(untilCommand({ until: { unlocked: "a" } })).toBeUndefined();
		expect(untilCommand({ until: { command: "  " } })).toBeUndefined();
		expect(untilCommand({})).toBeUndefined();
	});
});

describe("a timer stored with a removed condition", () => {
	/** A row as an earlier version wrote it: the table still accepts the kinds `file` and `port`. */
	const stored = (kind: "file" | "port" | "check", value: unknown) =>
		timers.insert(agent.db, {
			workspaceId,
			sessionId: "s1",
			note: "open the app",
			at: T0,
			kind: "until",
			dueAt: T0 + 5000,
			intervalMs: 5000,
			condition: {
				kind,
				value: typeof value === "string" ? value : JSON.stringify(value),
				cwd: root,
				baseline: "absent",
			},
			deadlineAt: T0 + 3_600_000,
		});
	const run = async (now: number) => {
		const woken: Array<NonNullable<ReturnType<typeof timers.get>>> = [];
		const checked = vi.fn(check());
		const failed = vi.fn();
		const instance = new TimerScheduler({
			db: () => agent,
			sessionId: "s1",
			now: () => now,
			check: checked,
			watch: conditionWatcher(deps()),
			wake: (each) => woken.push(each),
			failed,
		});
		started.push(instance);
		instance.refresh();
		await instance.tick();
		expect(failed).not.toHaveBeenCalled();
		expect(checked).not.toHaveBeenCalled();
		return woken;
	};

	it("is listed without a crash and stays active until its next check is due", async () => {
		const row = stored("file", { path: "build.done", is: "exists" });
		expect(timerLine(row, T0)).toContain("until file (not readable by this version)");
		expect(await run(T0 + 1000)).toEqual([]);
		expect(timers.get(agent.db, row.id)).toMatchObject({ status: "active" });
	});

	it("ends failed at its next check, with the command to set it again, instead of waiting out its deadline", async () => {
		const file = stored("file", { path: "build.done", is: "exists" });
		const port = stored("port", { port: 5173, host: "127.0.0.1" });
		const judged = stored("check", {
			question: "up?",
			on: { kind: "port", value: '{"port":8080,"host":"localhost"}' },
		});
		const woken = await run(T0 + 6000);
		expect(woken.map((row) => [row.id, row.status, row.stop_reason])).toEqual([
			[file.id, "failed", "until.file was removed; set the timer with until.command instead: test -e build.done"],
			[port.id, "failed", "until.port was removed; set the timer with until.command instead: nc -z 127.0.0.1 5173"],
			[judged.id, "failed", "until.port was removed; set the timer with until.command instead: nc -z localhost 8080"],
		]);
		expect(wakeText(woken[0])).toBe(
			[
				`Timer ${file.id} fired: stopped: until.file was removed; set the timer with until.command instead: test -e build.done (timer failed).`,
				"Note: open the app",
			].join("\n"),
		);
		expect(timers.activeCount(agent.db, "s1")).toBe(0);
	});

	it("names the replacement even when the stored text cannot be read", async () => {
		stored("file", "not json");
		const [ended] = await run(T0 + 6000);
		expect(ended).toMatchObject({ status: "failed", stop_reason: expect.stringContaining("test path -nt mark") });
	});
});
