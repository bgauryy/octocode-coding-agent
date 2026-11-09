import fs from "node:fs";
import net from "node:net";
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
	roots: () => [root],
	judge: judgeStub,
	...own,
});
const check = (own?: Partial<ConditionDeps>) => conditionChecker(deps(own));
const owner = { workspaceId: "w", sessionId: "s1", cwd: "/" };

describe("the closed list of until conditions", () => {
	it("takes exactly one condition, named from the list", () => {
		expect(parseUntil({ file: { path: "a", is: "exists" } })).toEqual({ kind: "file", path: "a", is: "exists" });
		expect(parseUntil({ file: { path: "a" } })).toMatchObject({ is: "changed" });
		expect(parseUntil({ item: { ref: "B1", state: "done" } })).toMatchObject({ kind: "item" });
		expect(parseUntil({ agent: { name: "ui" } })).toMatchObject({ kind: "agent" });
		expect(parseUntil({ port: { port: 5173 } })).toEqual({ kind: "port", port: 5173, host: "127.0.0.1" });
		expect(() => parseUntil({ job: "x" })).toThrow(/no condition job/);
		expect(() => parseUntil({ message: "x" })).toThrow(/no condition message/);
		expect(() => parseUntil({})).toThrow(/exactly one/);
		expect(() => parseUntil({ command: "true", unlocked: "a" })).toThrow(/exactly one/);
		expect(() => parseUntil({ file: { path: "a", glob: "*" } })).toThrow(/no field glob/);
		expect(() => parseUntil({ file: { path: "a", is: "dir" } })).toThrow(/until.file.is/);
		expect(() => parseUntil({ item: { ref: "B1", state: "lost" } })).toThrow(/until.item.state/);
		expect(() => parseUntil({ item: { ref: " ", state: "done" } })).toThrow(/until.item.ref/);
		expect(parseUntil({ item: { ref: "B1", state: "done" } })).toEqual({ kind: "item", ref: "B1", state: "done" });
	});

	it("limits port to loopback and valid numbers", () => {
		expect(parseUntil({ port: { port: 80, host: "localhost" } })).toMatchObject({ host: "localhost" });
		expect(() => parseUntil({ port: { port: 80, host: "10.0.0.5" } })).toThrow(/loopback/);
		expect(() => parseUntil({ port: { port: 0 } })).toThrow(/1 to 65535/);
	});

	it("check names one trigger from the same list and cannot nest", () => {
		const parsed = parseUntil({ check: "done?", file: { path: "a" } });
		expect(parsed).toMatchObject({ kind: "check", question: "done?", on: { kind: "file" } });
		expect(() => parseUntil({ check: "x" })).toThrow(/trigger condition/);
		expect(() => parseUntil({ check: "x", command: "true", file: { path: "a" } })).toThrow(/exactly one/);
	});

	it("stores each kind and reads it back from the row", () => {
		const file = timerFields(
			{ note: "n", until: { file: { path: "a.txt", is: "exists" } } },
			T0,
			{ ...owner, cwd: root },
			deps(),
		);
		expect(file.condition).toMatchObject({ kind: "file", baseline: expect.any(String) });
		const row = timers.insert(agent.db, { ...file, workspaceId });
		expect(timerLine(row, T0)).toContain("a.txt exists");
		expect(timerLine(row, T0)).toContain("watching");
		const port = timerFields({ note: "n", until: { port: { port: 5173 } } }, T0, { ...owner, cwd: root }, deps());
		expect(port.intervalMs).toBe(5000);
		expect(timerFields({ note: "n", until: { command: "true" } }, T0, owner).intervalMs).toBe(15_000);
	});
});

describe("deterministic conditions", () => {
	it("file exists / absent", async () => {
		const target = path.join(root, "out.txt");
		const exists = { kind: "file", path: "out.txt", is: "exists" } as const;
		const absent = { ...exists, is: "absent" } as const;
		const run = (condition: TimerCondition) => check()(condition, { cwd: root, baseline: undefined });
		expect(await run(exists)).toMatchObject({ met: false });
		expect(await run(absent)).toMatchObject({ met: true });
		fs.writeFileSync(target, "x");
		expect(await run(exists)).toMatchObject({ met: true });
		expect(await run(absent)).toMatchObject({ met: false });
	});

	it("file changed compares with the baseline taken at set time, and holds through the settle window", async () => {
		const target = path.join(root, "log.txt");
		fs.writeFileSync(target, "one");
		const condition = parseUntil({ file: { path: "log.txt" } })!;
		const baseline = timerFields(
			{ note: "n", until: { file: { path: "log.txt" } } },
			T0,
			{ ...owner, cwd: root },
			deps(),
		).condition!.baseline;
		const run = () => check()(condition, { cwd: root, baseline });
		expect(await run()).toMatchObject({ met: false });
		fs.writeFileSync(target, "one and more");
		expect(await run()).toMatchObject({ met: true });
		// A write still going on while the check settles is not "changed" yet.
		const writer = setInterval(() => fs.appendFileSync(target, "."), 60);
		try {
			expect((await run()).met).toBe(false);
		} finally {
			clearInterval(writer);
		}
	});

	it("file refuses a path outside the workspace, and follows no symlink out of it", async () => {
		const outside = tmp();
		fs.writeFileSync(path.join(outside, "secret"), "x");
		fs.symlinkSync(outside, path.join(root, "link"));
		for (const raw of [path.join(outside, "secret"), "../escape", "link/secret"]) {
			const outcome = await check()({ kind: "file", path: raw, is: "exists" }, { cwd: root, baseline: undefined });
			expect(outcome).toMatchObject({ met: false, refused: expect.stringContaining("outside the workspace") });
		}
		fs.rmSync(outside, { recursive: true, force: true });
	});

	it("item with several refs fires when any reaches the state and names it", async () => {
		const input = { cwd: root, baseline: undefined };
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
		const input = { cwd: root, baseline: undefined };
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
		const input = { cwd: root, baseline: undefined };
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

	it("port connects to a loopback listener only", async () => {
		const server = net.createServer().listen(0, "127.0.0.1");
		await new Promise((resolve) => server.once("listening", resolve));
		const { port } = server.address() as net.AddressInfo;
		const condition = { kind: "port", port, host: "127.0.0.1" } as const;
		const input = { cwd: root, baseline: undefined };
		expect(await check()(condition, input)).toMatchObject({ met: true });
		await new Promise((resolve) => server.close(resolve));
		expect(await check()(condition, input)).toMatchObject({ met: false });
	});
});

describe("event sources only poke a check", () => {
	const watched = (
		until: unknown,
		watch: ReturnType<typeof conditionWatcher>,
		scheduleDeps: Partial<ConditionDeps> = {},
	) => {
		const row = timers.insert(agent.db, {
			...timerFields(
				{ note: "n", until, every: 60 },
				Date.now(),
				{ ...owner, workspaceId, cwd: root },
				deps(scheduleDeps),
			),
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

	it("wakes on a file event long before the safety poll, through the parent directory", async () => {
		const target = path.join(root, "build.done");
		const { woken } = watched({ file: { path: "build.done", is: "exists" } }, conditionWatcher(deps()));
		await new Promise((resolve) => setTimeout(resolve, 100));
		// An atomic save: write a temp name, rename over the target.
		fs.writeFileSync(`${target}.tmp`, "x");
		fs.renameSync(`${target}.tmp`, target);
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
			{ cwd: root, baseline: undefined, row: { id: 1, checks: 0, spentUsd: 0, sessionId: "s1" } },
		);
		expect(outcome).toMatchObject({ met: false });
		expect(outcome.spend).toBeUndefined();
		expect(j.complete).not.toHaveBeenCalled();
	});

	it("judges once the trigger fires, with the evidence as quoted untrusted data, and reports the spend", async () => {
		const j = judging([verdict("met", "migration finished")]);
		const outcome = await check({ item: () => "done", judge: (r) => j.judge.judge(r) })(
			parseUntil({ check: "q?", item: { ref: "B1", state: "done" } })!,
			{ cwd: root, baseline: undefined, row: { id: 1, checks: 0, spentUsd: 0, sessionId: "s1" } },
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
			timerFields({ note: "n", until, every: 30 }, T0, { ...owner, workspaceId, cwd: root }, deps(own)),
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
	const checkUntil = { check: "done?", file: { path: "x.txt" } };

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
		await set(host, ctx, { file: { path: "x.txt", is: "exists" } });
		await set(host, ctx, { port: { port: 5173 } });
		expect(ctx.ui.confirms).toHaveLength(0);
		expect(
			runningWorkOf(host.api)
				.all()
				.map((row) => row.title),
		).toEqual(["until x.txt exists", "until port 5173 is listening"]);
		const row = timers.forSession(agent.db, "s1")[0];
		timers.recordResult(agent.db, row.id, { exit: null, output: "", spend: { calls: 1, usd: 0.003 } }, Date.now());
		const list = await host.tools.get("timer").execute("l", { op: "list" }, undefined, undefined, ctx);
		expect(list.content[0].text).toContain("watching");
		expect(list.content[0].text).toContain("polling every 5s");
		await host.fire("session_shutdown", {}, ctx);
	});
});

describe("gates see a command wherever until carries it", () => {
	it("reads the command of a plain until and of a check's trigger", () => {
		expect(untilCommand({ until: { command: "test -f a" } })).toBe("test -f a");
		expect(untilCommand({ until: { check: "q", command: "make -q" } })).toBe("make -q");
		expect(untilCommand({ until: { file: { path: "a" } } })).toBeUndefined();
		expect(untilCommand({ until: { command: "  " } })).toBeUndefined();
		expect(untilCommand({})).toBeUndefined();
	});
});
