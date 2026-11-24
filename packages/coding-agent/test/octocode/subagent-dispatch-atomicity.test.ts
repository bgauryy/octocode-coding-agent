import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";
import type { Runners } from "../../src/octocode/subagents/runner-port.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { registerBacklogTool } from "../../src/octocode/native/tools/backlog/tool.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { fakeCachePolicy, fakeCtx, fakeHost, fakePermission, meteredBilling } from "./fake-host.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";

const FIXTURE = path.join(import.meta.dirname, "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

beforeAll(() => {
	const root = tmp("octocode-agent-dispatch-");
	resetOctocodeEnv();
	Object.assign(process.env, {
		OCTOCODE_HOME: path.join(root, "home"),
		OCTOCODE_AGENT_DB: path.join(root, "team", "team.sqlite"),
	});
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

const profiles = new Map<string, AgentProfile>([
	["reviewer", { name: "reviewer", description: "reads", prompt: "Review only.", readOnly: true }],
]);

const open: TeamStore[] = [];
const teams: Team[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const team of teams.splice(0)) team.stop();
	for (const store of open.splice(0)) {
		for (const id of store.names()) store.remove(id);
		store.close();
	}
});

/** A model whose cache read is cheaper than its cache write: siblings sharing a prefix are staggered. */
const pricedModel = {
	provider: "anthropic",
	id: "priced",
	api: "anthropic-messages",
	reasoning: true,
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

function setup(options: { runners?: Runners; model?: Record<string, unknown> } = {}) {
	const cwd = fs.realpathSync(tmp("octocode-dispatch-cwd-"));
	const f = fakeHost({ subagents: { queuedStarts: true } });
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	Object.assign(f.api.channels, {
		on: (channel: string, handler: (data: unknown) => void) => {
			listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
			return () => undefined;
		},
		emit: (channel: string, data: unknown) => listeners.get(channel)?.forEach((handler) => handler(data)),
	});
	const team = new Team(f.api);
	teams.push(team);
	const permission = fakePermission();
	registerBacklogTool(f.api, { isSubagent: false });
	const control = registerAgentTool(f.api, {
		profiles: () => profiles,
		team,
		permission,
		...(options.runners ? { runners: options.runners } : {}),
	});
	const ctx = fakeCtx({ cwd, hasUI: true });
	Object.assign(ctx.ui, { confirm: async () => true });
	const model = options.model ?? { provider: "faux", id: "model", reasoning: true };
	Object.assign(ctx, {
		model,
		modelRegistry: {
			...meteredBilling,
			getAvailable: () => [model],
			find: () => model,
			getCachePolicy: fakeCachePolicy,
			getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
		},
	});
	team.start(ctx);
	team.join();
	const agent = f.tools.get("agent");
	const run = (params: Record<string, unknown>, signal?: AbortSignal) =>
		agent.execute("call-1", { goal: "check things", ...params }, signal, undefined, ctx);
	const store = TeamStore.open(cwd, process.env.OCTOCODE_AGENT_DB);
	open.push(store);
	const write = (params: Record<string, unknown>) =>
		f.tools.get("backlog").execute("c", params, undefined, undefined, ctx);
	return { ...f, team, control, ctx, run, store, write, backlog: openBacklog(ctx, { isSubagent: false }) };
}

const READY = { goal: "Expected result", why: "Required work" };
const passed = (key: string, summary = "Implemented") => ({
	summary,
	files: [],
	verification: { status: "passed" as const, summary: "Focused check passed" },
	operationKey: key,
});
const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true), { interval: 25 });
const messages = (s: ReturnType<typeof setup>) => s.sent.map(({ message }) => String(message.content)).join("\n");
const gateFile = () => path.join(fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "gate-")), "open");

describe("queue admission of concurrent task calls", () => {
	it("refuses the second of two calls that would wait for each other's items, when both start together", async () => {
		const s = setup();
		await s.fire("session_start", { type: "session_start", reason: "startup" }, s.ctx);
		s.backlog.store.add({ ...READY, title: "one", state: "todo", createdBy: "user" });
		s.backlog.store.add({ ...READY, title: "two", state: "todo", createdBy: "user" });
		// Started without awaiting between them: both calls validate before either is queued.
		const results = await Promise.allSettled([
			s.run({ task: "echo task one", goal: "one", item: "B1", background: true, after: ["B2"] }),
			s.run({ task: "echo task two", goal: "two", item: "B2", background: true, after: ["B1"] }),
		]);
		expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
		const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
		expect(String(refused.reason)).toMatch(/Cycle/);
		expect(s.control.queued()).toHaveLength(1);
		await s.control.stopAll();
	});

	it("admits at most MAX_QUEUED children when more calls start together", async () => {
		const s = setup();
		const gate = gateFile();
		const first = await s.run({ task: `chain gate ${gate}`, goal: "first", background: true });
		const calls = Array.from({ length: 13 }, (_, index) =>
			s.run({
				task: `echo task ${index}`,
				goal: `queued ${index}`,
				background: true,
				after: [`agent:${first.details.id}`],
			}),
		);
		const results = await Promise.allSettled(calls);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(12);
		const refused = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		expect(refused).toHaveLength(1);
		expect(String(refused[0]?.reason)).toMatch(/at most 12/);
		expect(s.control.queued()).toHaveLength(12);
		await s.control.stopAll();
	});

	it("gives a refused call's place back: a call that fails after admission leaves the queue room", async () => {
		const s = setup();
		const gate = gateFile();
		const first = await s.run({ task: `chain gate ${gate}`, goal: "first", background: true });
		const after = [`agent:${first.details.id}`];
		// The task names an unreadable reference: the call fails after its place was reserved.
		const failing = Array.from({ length: 13 }, (_, index) =>
			s.run({ task: `report:nobody-${index}`, goal: `failing ${index}`, background: true, after }),
		);
		await Promise.allSettled(failing);
		expect(s.control.queued()).toHaveLength(0);
		const results = await Promise.allSettled(
			Array.from({ length: 12 }, (_, index) =>
				s.run({ task: `echo task ${index}`, goal: `queued ${index}`, background: true, after }),
			),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(12);
		await s.control.stopAll();
	});
});

describe("predecessor handoff", () => {
	it("gives a child the summary of an item that was done before the call", async () => {
		const s = setup();
		s.backlog.store.add({ ...READY, title: "api", state: "todo", createdBy: "user" });
		await s.write({ op: "claim", id: "B1", why: "w", goal: "g" });
		await s.write({ op: "done", id: "B1", completion: passed("k1", "Built the endpoint") });
		await s.run({ task: "echo whole task needs the api", goal: "ui", background: true, after: ["B1"] });
		await until(() => messages(s).includes("Background subagent"));
		expect(messages(s)).toContain("B1 (api) is done: Built the endpoint");
		await s.control.stopAll();
	});

	it("gives a child the report of an agent that ended before the call", async () => {
		const s = setup();
		const input = { task: "echo whole task FIRST-REPORT-MARK", goal: "first", background: true };
		const first = await s.run(input);
		const a = first.details.id as string;
		await until(() => messages(s).includes(`Background subagent ${a}`));
		const delivered = s.sent
			.map(({ message }) => String(message.content))
			.find((text) => text.includes(`Background subagent ${a}`))!;
		// The session records the child's delivered report; that record is what `report:<id>` reads.
		const entries = [
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "agent", arguments: input }] },
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "agent",
					content: [{ type: "text", text: delivered }],
					details: { id: a, profile: "general", goal: "first", status: "done", agentType: "task" },
				},
			},
		];
		Object.assign(s.ctx.sessionManager, { getEntries: () => entries });
		const second = await s.run({
			task: "echo whole task second",
			goal: "second",
			background: true,
			after: [`agent:${a}`],
		});
		const b = second.details.id as string;
		await until(() => messages(s).includes(`Background subagent ${b}`));
		const reported = s.sent
			.map(({ message }) => String(message.content))
			.filter((text) => text.includes(`subagent ${b}`));
		expect(reported.join("\n")).toContain("FIRST-REPORT-MARK");
		await s.control.stopAll();
	});
});

describe("cancelling a queued or starting child", () => {
	it("settles a child waiting for its prerequisites: its report arrives and the queue empties", async () => {
		const s = setup();
		const first = await s.run({ task: "abortable work", goal: "first", background: true });
		const waiting = await s.run({
			task: "echo task x",
			goal: "second",
			background: true,
			after: [`agent:${first.details.id}`],
		});
		const b = waiting.details.id as string;
		expect(s.control.stop(b, "user")).toBeUndefined();
		await until(() => s.control.queued().length === 0);
		await until(() => messages(s).includes(`Background subagent ${b}`));
		expect(messages(s)).toMatch(new RegExp(`${b} \\(general: second\\) cancelled by the user`));
		await s.control.stopAll();
	});

	it("settles a child cancelled while it waits for a slot and leaves the slot for the next", async () => {
		vi.stubEnv("OCTOCODE_MAX_SUBAGENTS", "1");
		const s = setup();
		await s.fire("session_start", { type: "session_start", reason: "startup" }, s.ctx);
		s.backlog.store.add({ ...READY, title: "api", state: "todo", createdBy: "user" });
		s.backlog.store.add({ ...READY, title: "ui", state: "todo", createdBy: "user", dependsOn: ["B1"] });
		// B1 is done by the coordinator while a running child holds the only slot.
		const holder = await s.run({ task: "abortable work", goal: "holder", background: true });
		const queued = await s.run({ task: "echo task ui", item: "B2", background: true });
		const id = queued.details.id as string;
		await s.write({ op: "claim", id: "B1", why: "w", goal: "g" });
		await s.write({ op: "done", id: "B1", completion: passed("k1") });
		// The child left its prerequisite wait and claimed B2; now it waits for the slot.
		await until(() => s.backlog.store.get("B2")?.state === "ongoing");
		expect(s.control.stop(id, "user")).toBeUndefined();
		await until(() => messages(s).includes(`Background subagent ${id}`));
		await until(() => s.control.queued().length === 0);
		// The slot it never took is free for the next one; the item stays claimed by the session, as for any stopped child.
		expect(s.control.stop(holder.details.id as string, "user")).toBeUndefined();
		await until(() => messages(s).includes(`Background subagent ${holder.details.id}`));
		const next = await s.run({ task: "echo task again", goal: "again", background: true });
		await until(() => messages(s).includes(`Background subagent ${next.details.id}`));
		await s.control.stopAll();
	});
});

describe("external runner tasks under cache staggering", () => {
	it("runs independent runner tasks in parallel when the parent model has cache prices", async () => {
		let active = 0;
		let peak = 0;
		const release: Array<() => void> = [];
		const runners: Runners = {
			ids: ["claude-code"],
			turn: async () => {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise<void>((resolve) => release.push(resolve));
				active -= 1;
				return { text: "done: finished\nNoticed: none", billing: "plan" as const };
			},
		};
		vi.stubEnv("OCTOCODE_MAX_SUBAGENTS", "3");
		const s = setup({ runners, model: pricedModel });
		await Promise.all([
			s.run({ task: "read a", goal: "read a", runner: "claude-code", background: true }),
			s.run({ task: "read b", goal: "read b", runner: "claude-code", background: true }),
		]);
		await vi.waitFor(() => expect(release).toHaveLength(2), { interval: 25 });
		expect(peak).toBe(2);
		for (const done of release) done();
		await until(() => (messages(s).match(/Background subagent/g) ?? []).length >= 2);
		await s.control.stopAll();
	});
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));
