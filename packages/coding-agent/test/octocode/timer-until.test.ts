import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, openDatabase, timers } from "../../../db/src/api.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import type { FeatureContext } from "../../src/core/features/index.ts";
import { runningWorkOf } from "../../src/octocode/shared/running-work.ts";
import { conditionChecker, conditionWatcher } from "../../src/octocode/timer/condition.ts";
import { parseUntil } from "../../src/octocode/timer/conditions/index.ts";
import type { ConditionDeps, TimerCondition } from "../../src/octocode/timer/conditions/types.ts";
import { CHECK_CAPS, Judge, type JudgeHost } from "../../src/octocode/timer/judge.ts";
import { decideFire, timerFields, timerLine, wakeDetails, wakeText } from "../../src/octocode/timer/model.ts";
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
		mirrorFile: path.join(root, "transcripts.db"),
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

	it("refuses a condition it does not know, naming the choices", () => {
		expect(() => parseUntil({ file: { path: "out.txt" } })).toThrow(/until has no condition file; the choices are/);
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
			"until `test -e a.txt` exits 0 · polling every 15s",
		);
	});
});

describe("deterministic conditions", () => {
	it("a command is met when it exits 0", async () => {
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
		const waiting: Array<() => void> = [];
		const instance = new TimerScheduler({
			db: () => agent,
			sessionId: "s1",
			check: check(scheduleDeps),
			watch,
			wake: (each) => woken.push(each),
			pokeChecked: () => waiting.splice(0).forEach((resolve) => resolve()),
		});
		started.push(instance);
		instance.refresh();
		/** Resolves when the next event-driven check has ended; ask before the event. */
		const nextPokeCheck = () => new Promise<void>((resolve) => waiting.push(resolve));
		return { row, woken, instance, nextPokeCheck };
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
		const { row, woken, nextPokeCheck } = watched({ item: { ref: "B1", state: "done" } }, watch, {
			item: () => state,
		});
		const before = timers.get(agent.db, row.id)!;
		const quietCheck = nextPokeCheck();
		poke();
		await quietCheck;
		expect(timers.get(agent.db, row.id)).toEqual(before);
		state = "done";
		poke();
		await vi.waitFor(() => expect(woken).toHaveLength(1), { timeout: 3000 });
	});

	it("a dead watcher polls at the fallback interval before the cached safety check", async () => {
		vi.useFakeTimers({ now: T0 });
		const stop = vi.fn();
		let state = "todo";
		let failed: () => void = () => undefined;
		const watch = (_c: TimerCondition, _cwd: string, _poke: () => void, onFail: () => void) => {
			failed = onFail;
			return stop;
		};
		const { row, instance, woken } = watched({ item: { ref: "B1", state: "done" } }, watch, {
			item: () => state,
		});
		await instance.tick();
		expect(timers.get(agent.db, row.id)!.due_at).toBe(T0 + 60_000);
		await vi.advanceTimersByTimeAsync(1000);
		failed();
		expect(timers.get(agent.db, row.id)!.due_at).toBe(T0 + 16_000);
		state = "done";
		await vi.advanceTimersByTimeAsync(15_000);
		expect(woken).toMatchObject([{ status: "done", stop_reason: "met" }]);
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

	it("a watcher that fails on subscribe keeps an already-due check immediate", async () => {
		vi.useFakeTimers({ now: T0 });
		const { instance, woken } = watched(
			{ item: { ref: "B1", state: "done" } },
			(_condition, _cwd, _poke, failed) => {
				failed();
				return () => undefined;
			},
			{ item: () => "done" },
		);
		await instance.tick();
		expect(woken).toMatchObject([{ status: "done", stop_reason: "met" }]);
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
	} as unknown as FeatureContext;
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

	it("does not count a rate limit or a transient failure toward the failures that end the wait", async () => {
		const j = judging([
			new Error("429 Too Many Requests"),
			new Error("boom"),
			new Error("503 Service Unavailable: overloaded"),
			new Error("429 rate limit exceeded"),
			new Error("boom"),
		]);
		for (let call = 0; call < 4; call++) {
			expect(await j.judge.judge(ask())).toMatchObject({ verdict: "skipped" });
			j.advance(60_000);
		}
		expect(await j.judge.judge(ask())).toMatchObject({ verdict: "stop", reason: expect.stringContaining("2 times") });
		expect(j.complete).toHaveBeenCalledTimes(5);
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
	/** The `on` call that stands for an `until` condition. */
	const onArgs = (until: Record<string, any>) => {
		const { check, ...rest } = until;
		const [kind, value] = Object.entries(rest)[0];
		const base =
			kind === "command"
				? { event: "check.result", filter: { command: value } }
				: kind === "unlocked"
					? { event: "path.unlocked", filter: { path: value } }
					: kind === "agent"
						? { event: "agent.ended", filter: { agent: (value as { name: string }).name } }
						: { event: "item.state", filter: value };
		return { op: "on", note: "n", ...base, ...(check ? { check } : {}) };
	};
	const set = (host: ReturnType<typeof fakeHost>, ctx: unknown, until: Record<string, unknown>) =>
		host.tools.get("notify").execute("c", onArgs(until), undefined, undefined, ctx);
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
		expect(first.content[0].text).toMatch(/Judging is capped: 5 judgments and \$0\.05 per request/);
		expect(ctx.ui.confirms).toHaveLength(0);
		const second = await set(host, ctx, checkUntil);
		expect(second.content[0].text).toContain("Judging is capped");
		await host.fire("session_shutdown", {}, ctx);
	});

	it("does not persist a timer when cancelled while awaiting judging consent", async () => {
		const { host, ctx } = session();
		const controller = new AbortController();
		ctx.ui.confirm = async () => {
			controller.abort(new Error("cancelled"));
			return true;
		};
		await host.fire("session_start", { reason: "startup" }, ctx);
		try {
			await expect(
				host.tools.get("notify").execute("c", onArgs(checkUntil), controller.signal, undefined, ctx),
			).rejects.toThrow("cancelled");
			expect(timers.activeCount(agent.db, "s1")).toBe(0);
		} finally {
			await host.fire("session_shutdown", {}, ctx);
		}
	});

	it("rejects a judging approval that arrives after the session changes", async () => {
		const { host, ctx } = session();
		let answer: (yes: boolean) => void = () => undefined;
		ctx.ui.confirm = () =>
			new Promise((resolve) => {
				answer = resolve;
			});
		await host.fire("session_start", { reason: "startup" }, ctx);
		const pending = set(host, ctx, checkUntil);
		const next = { ...ctx, sessionManager: { getSessionId: () => "s2", getBranch: () => [] } };
		await host.fire("session_start", { reason: "switch" }, next);
		answer(true);
		try {
			await expect(pending).rejects.toThrow(/session changed/);
			expect(timers.forSession(agent.db, "s1")).toHaveLength(0);
			ctx.ui.confirm = async () => false;
			await expect(set(host, next, checkUntil)).rejects.toThrow(/declined/);
		} finally {
			await host.fire("session_shutdown", {}, next);
		}
	});

	it("does not carry first-use judging consent into another session", async () => {
		const { host, ctx } = session();
		ctx.ui.confirms.push(true);
		await host.fire("session_start", { reason: "startup" }, ctx);
		await set(host, ctx, checkUntil);
		const next = { ...ctx, sessionManager: { getSessionId: () => "s2", getBranch: () => [] } };
		ctx.ui.confirms.push(false);
		await host.fire("session_start", { reason: "switch" }, next);
		try {
			await expect(set(host, next, checkUntil)).rejects.toThrow(/declined/);
			expect(timers.activeCount(agent.db, "s2")).toBe(0);
		} finally {
			await host.fire("session_shutdown", {}, next);
		}
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
		const list = await host.tools.get("notify").execute("l", { op: "list" }, undefined, undefined, ctx);
		expect(list.content[0].text).toContain("watching");
		expect(list.content[0].text).toContain("polling every 15s");
		await host.fire("session_shutdown", {}, ctx);
	});

	it("declares a closed event list and refuses anything else with the choices", async () => {
		const { host, ctx } = session();
		const tool = host.tools.get("notify");
		expect(Object.keys(tool.parameters.properties)).not.toContain("until");
		expect([...tool.parameters.properties.event.enum].sort((a: string, b: string) => a.localeCompare(b))).toEqual([
			"agent.ended",
			"check.result",
			"item.changed",
			"item.state",
			"machine.load",
			"path.unlocked",
			"peer.landed",
		]);
		const call = (args: object) => tool.execute("c", { op: "on", note: "n", ...args }, undefined, undefined, ctx);
		await expect(call({ event: "file.changed" })).rejects.toThrow(
			/No event "file\.changed": the choices are agent\.report/,
		);
		await expect(call({ event: "agent.report" })).rejects.toThrow("You are already notified");
		await expect(call({ event: "time.due" })).rejects.toThrow("use set with after or every");
		await expect(call({ event: "path.unlocked" })).rejects.toThrow("path.unlocked needs filter.path");
		await expect(call({ event: "path.unlocked", filter: { path: "a", ref: "B1" } })).rejects.toThrow(
			"filters on path, not ref",
		);
		// A check that only repeats the command would pay a model for what the command already decides.
		await expect(
			call({
				event: "check.result",
				filter: { command: "grep -q Duration a.log" },
				check: 'grep -q "Duration"  a.log',
			}),
		).rejects.toThrow("check repeats filter.command");
		await expect(
			tool.execute("c", { op: "set", after: 5, note: "n", event: "item.state" }, undefined, undefined, ctx),
		).rejects.toThrow("belong to on");
	});

	it("listens with on, answers one line, lists what wakes it unasked, and ends with off", async () => {
		const { host, ctx } = session();
		await host.fire("session_start", { reason: "startup" }, ctx);
		const tool = host.tools.get("notify");
		const run = (args: object) => tool.execute("c", args, undefined, undefined, ctx);
		const on = await run({
			op: "on",
			note: "n",
			event: "check.result",
			filter: { command: "true" },
			once: false,
			maxRuns: 3,
			deadline: 900,
		});
		const id = on.details.timer.id as number;
		expect(on.content[0].text).toBe(`Listening ${id}: \`true\` exits 0 · up to 3 wakes · ≤15m`);
		expect(timers.get(agent.db, id)).toMatchObject({ kind: "until", max_runs: 3, baseline: "armed:0" });
		const list = await run({ op: "list" });
		expect(list.content[0].text).toContain(`${id} · on \`true\` exits 0 0/3 wakes · polling every 15s · ≤`);
		expect(list.content[0].text).not.toContain("next check in");
		await expect(
			run({ op: "on", note: "n", event: "check.result", filter: { command: "true" }, maxRuns: 2 }),
		).rejects.toThrow("maxRuns counts wakes");
		expect((await run({ op: "off", id })).content[0].text).toMatch(new RegExp(`^Cancelled ${id} · on `));
		expect(timers.activeCount(agent.db, "s1")).toBe(0);
		await host.fire("session_shutdown", {}, ctx);
	});
});

describe("gates see a command wherever a wait carries it", () => {
	it("reads the command of an on check.result, a check question beside it included", () => {
		expect(untilCommand({ filter: { command: "test -f a" } })).toBe("test -f a");
		expect(untilCommand({ check: "q", filter: { command: "make -q" } })).toBe("make -q");
		expect(untilCommand({ filter: { path: "a" } })).toBeUndefined();
		expect(untilCommand({ filter: { command: "  " } })).toBeUndefined();
		expect(untilCommand({})).toBeUndefined();
	});
});

describe("timer check resource ownership", () => {
	const add = () =>
		timers.insert(
			agent.db,
			timerFields({ note: "check", until: { command: "true" } }, T0, { ...owner, workspaceId, cwd: root }),
		);

	it("aborts a stopped scheduler's checks without writing or waking after a late result", async () => {
		const row = add();
		let finish!: (value: { met: boolean; exit: number; output: string }) => void;
		let signal: AbortSignal | undefined;
		const wake = vi.fn();
		const wrote = vi.fn();
		const failed = vi.fn();
		const forget = vi.fn();
		const scheduler = new TimerScheduler({
			db: () => agent,
			sessionId: "s1",
			now: () => T0,
			wake,
			wrote,
			failed,
			forget,
			check: (_condition, input) => {
				signal = input.signal;
				return new Promise((resolve) => {
					finish = resolve;
				});
			},
		});
		started.push(scheduler);
		scheduler.hold(row.id);
		scheduler.refresh();
		const holding = scheduler.settle();
		const checking = scheduler.tick();
		expect(signal?.aborted).toBe(false);
		scheduler.stop();
		expect(signal?.aborted).toBe(true);
		await holding;
		const writes = wrote.mock.calls.length;
		finish({ met: true, exit: 0, output: "late" });
		await checking;
		expect(wrote).toHaveBeenCalledTimes(writes);
		expect(wake).not.toHaveBeenCalled();
		expect(failed).not.toHaveBeenCalled();
		expect(forget).toHaveBeenCalledExactlyOnceWith(row.id);
		expect(timers.get(agent.db, row.id)?.status).toBe("active");
	});

	it("cancels a removed timer's check while the scheduler remains live", async () => {
		const row = add();
		let signal: AbortSignal | undefined;
		const failed = vi.fn();
		const scheduler = new TimerScheduler({
			db: () => agent,
			sessionId: "s1",
			now: () => T0,
			wake: vi.fn(),
			failed,
			check: (_condition, input) =>
				new Promise((_resolve, reject) => {
					signal = input.signal;
					signal?.addEventListener("abort", () => reject(signal!.reason), { once: true });
				}),
		});
		started.push(scheduler);
		scheduler.refresh();
		const checking = scheduler.tick();
		timers.finish(agent.db, row.id, "cancelled", "user", T0);
		scheduler.refresh();
		expect(signal?.aborted).toBe(true);
		await checking;
		expect(failed).not.toHaveBeenCalled();
	});

	it("stops an in-flight model judgment and never starts one with an aborted signal", async () => {
		const { judge, host } = judging([]);
		const controller = new AbortController();
		let signal: AbortSignal | undefined;
		const call = vi.spyOn(host.small, "call").mockImplementation(
			(_ctx, input) =>
				new Promise((resolve) => {
					signal = input.signal;
					signal.addEventListener("abort", () => resolve({ error: "aborted" }), { once: true });
				}),
		);
		const result = judge.judge(ask({ signal: controller.signal }));
		const rejected = expect(result).rejects.toThrow("cancelled");
		controller.abort(new Error("cancelled"));
		expect(signal?.aborted).toBe(true);
		await rejected;
		await expect(judge.judge(ask({ signal: controller.signal }))).rejects.toThrow("cancelled");
		expect(call).toHaveBeenCalledOnce();
	});

	it("stops the process group of a running until-command check", async () => {
		const controller = new AbortController();
		const result = check()(
			{ kind: "command", command: "echo $$ > check.pid; exec sleep 60" },
			{ cwd: root, signal: controller.signal },
		);
		const rejected = expect(result).rejects.toThrow("cancelled");
		try {
			await vi.waitFor(() => expect(fs.existsSync(path.join(root, "check.pid"))).toBe(true));
			const pid = Number(fs.readFileSync(path.join(root, "check.pid"), "utf8").trim());
			controller.abort(new Error("cancelled"));
			await rejected;
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			controller.abort(new Error("cancelled"));
			await result.catch(() => {});
		}
	});
});

describe("a persistent listener wakes when its condition turns true, not while it stays true", () => {
	const base = (baseline: string, maxRuns = 2) => ({
		kind: "until",
		max_runs: maxRuns,
		baseline,
		deadline_at: null,
		last_fired_at: 0,
		created_at: 0,
	});
	const row = (baseline: string, maxRuns = 2) => base(baseline, maxRuns) as never;
	const met = { met: true, exit: null, output: "" };
	const open = { met: false, exit: null, output: "" };

	it("wakes at each rising edge, rearms when the condition drops, and ends after maxRuns", () => {
		expect(decideFire(row("armed:0"), met)).toEqual({ wake: true, persist: "fired:1" });
		expect(decideFire(row("fired:1"), met)).toEqual({ wake: false });
		expect(decideFire(row("fired:1"), open)).toEqual({ wake: false, persist: "armed:1" });
		expect(decideFire(row("armed:0"), open)).toEqual({ wake: false });
		expect(decideFire(row("armed:1"), met)).toEqual({
			wake: true,
			end: { status: "done", reason: "maxRuns" },
			persist: "fired:2",
		});
	});

	it("says which wake it is, and the last", () => {
		const woke = (baseline: string, status: "active" | "done", stop: string | null) =>
			wakeText({
				...(base(baseline, 2) as object),
				id: 4,
				note: "n",
				status,
				stop_reason: stop,
				condition_kind: "command",
				condition: JSON.stringify("true"),
				last_output: null,
				last_exit: null,
				checks: 0,
				spent_usd: 0,
			} as never);
		expect(woke("fired:1", "active", null)).toContain("wake 1 of 2)");
		expect(woke("fired:1", "active", null)).toContain("off id 4 to stop it");
		expect(woke("fired:2", "done", "maxRuns")).toContain("wake 2 of 2, the last)");
	});
});

describe("an expired command wait", () => {
	const expired = (output: string) =>
		({
			id: 9,
			kind: "until",
			note: "start checks once load is low",
			status: "expired",
			stop_reason: "deadline",
			max_runs: null,
			runs: 0,
			condition_kind: "command",
			condition: JSON.stringify("node scripts/test/full-run-lock.ts --status"),
			baseline: null,
			last_exit: 1,
			last_output: output,
			checks: 0,
			spent_usd: 0,
		}) as never;

	it("names the last exit code and the output tail, redacted and bounded", () => {
		const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
		const output = `${"x".repeat(5000)}\nheld by yarn test (pid 7)\ntoken ${secret}`;
		const text = wakeText(expired(output));
		const [headline] = text.split("\n");
		expect(headline).toContain("deadline reached before");
		expect(headline).toContain("last check exit 1");
		expect(text).toContain("Last check (exit 1): ");
		expect(text).toContain("held by yarn test (pid 7)");
		expect(text).not.toContain(secret);
		expect(text.length).toBeLessThan(1200);
	});

	it("says there was no output rather than nothing", () => {
		expect(wakeText(expired(""))).toContain("Last check (exit 1): (no output)");
	});
});
