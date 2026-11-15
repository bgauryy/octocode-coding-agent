import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { registerBacklogTool } from "../../src/octocode/backlog/tool.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { fakeCachePolicy, fakeCtx, fakeHost, fakePermission, meteredBilling } from "./fake-host.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";

const FIXTURE = path.join(import.meta.dirname, "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

beforeAll(() => {
	const root = tmp("octocode-agent-paths-");
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
	for (const team of teams.splice(0)) team.stop();
	// One database for the whole file: rows of this test do not leak into the next one's team.
	for (const store of open.splice(0)) {
		for (const id of store.names()) store.remove(id);
		store.close();
	}
});

function setup(cwd = fs.realpathSync(tmp("octocode-paths-cwd-"))) {
	const f = fakeHost({ subagents: { queuedStarts: true } });
	// The fake host's event bus is inert; chains and the backlog tool talk over the real one's contract.
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	Object.assign(f.api.events, {
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
	const control = registerAgentTool(f.api, { profiles: () => profiles, team, permission });
	const ctx = fakeCtx({ cwd, hasUI: true });
	Object.assign(ctx.ui, { confirm: async () => true });
	const model = { provider: "faux", id: "model", reasoning: true };
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
	/** The reservations in this checkout, as another process reads them. */
	const leases = () => store.leases().map((lease) => ({ path: lease.path, kind: lease.kind, owner: lease.owner }));
	const rows = () => store.names().filter((id) => id !== team.id);
	return {
		...f,
		permission,
		backlog: openBacklog(ctx, { isSubagent: false }),
		team,
		control,
		ctx,
		run,
		cwd,
		store,
		leases,
		rows,
	};
}

const textOf = (result: { content: Array<{ text?: string }> }) => result.content[0]?.text ?? "";
const until = (check: () => boolean) => vi.waitFor(() => expect(check()).toBe(true), { timeout: 15_000, interval: 25 });

const READY = { goal: "Expected result", why: "Required work" };
const passed = (key: string) => ({
	summary: "Implemented",
	files: [],
	verification: { status: "passed" as const, summary: "Focused check passed" },
	operationKey: key,
});

describe("queued dependent children", () => {
	it("holds a queued child, naming why, when the permission policy no longer allows its start", async () => {
		const s = setup();
		const gate = path.join(fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "gate-")), "open");
		const first = await s.run({ task: `chain gate ${gate}`, goal: "first", background: true });
		const queued = await s.run({
			task: "echo task b",
			goal: "second",
			background: true,
			after: [`agent:${first.details.id}`],
		});
		vi.spyOn(s.permission, "check").mockResolvedValue({
			allowed: false,
			via: "policy",
			message: "policy now refuses subagents",
		});
		fs.writeFileSync(gate, "go");
		await until(() => /held/.test(s.control.queued()[0] ?? ""));
		expect(s.control.queued()[0]).toContain(`${queued.details.id} held`);
		expect(s.control.queued()[0]).toContain("policy now refuses subagents");
		expect(s.sent.map(({ message }) => String(message.content)).join("\n")).toContain("policy now refuses subagents");
		await s.control.stopAll();
	});

	it("starts a queued child at the coordinator's own backlog write, names no ready item, and refuses a second start", async () => {
		const s = setup();
		await s.fire("session_start", { type: "session_start", reason: "startup" }, s.ctx);
		s.backlog.store.add({ ...READY, title: "api", state: "todo", createdBy: "user" });
		s.backlog.store.add({ ...READY, title: "ui", state: "todo", createdBy: "user", dependsOn: ["B1"] });
		const queued = await s.run({ task: "echo whole task", item: "B2", background: true });
		const id = queued.details.id as string;
		expect(textOf(queued)).toContain(`Queued ${id}`);
		await expect(s.run({ task: "other", item: "B2", background: true })).rejects.toThrow(
			new RegExp(`B2 is being worked on by ${id}`),
		);
		const backlog = s.tools.get("backlog");
		const write = (params: Record<string, unknown>) => backlog.execute("c", params, undefined, undefined, s.ctx);
		await write({ op: "claim", id: "B1", why: "w", goal: "g" });
		const done = await write({ op: "done", id: "B1", completion: passed("k1") });
		expect(textOf(done)).not.toMatch(/ready|B2/);
		await until(() => s.sent.some(({ message }) => String(message.content).includes(`Background subagent ${id}`)));
		expect(s.control.queued()).toEqual([]);
		await s.control.stopAll();
	});

	it("starts B when A reports done, with no further call and A's report in its task, then tells the coordinator", async () => {
		const s = setup();
		const gate = path.join(fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "gate-")), "open");
		const first = await s.run({ task: `chain gate ${gate}`, goal: "first", background: true });
		const a = first.details.id as string;
		const queued = await s.run({
			task: `echo whole task after ${a}`,
			goal: "second",
			background: true,
			after: [`agent:${a}`],
		});
		expect(textOf(queued)).toContain(`Queued ${queued.details.id}`);
		expect(textOf(queued)).toContain(`starts when agent:${a} is done`);
		expect(queued.details.after).toEqual([`agent:${a}`]);
		expect(s.control.queued()[0]).toContain(`queued after agent:${a}`);
		const b = queued.details.id as string;
		fs.writeFileSync(gate, "go");
		await until(() => s.sent.some(({ message }) => String(message.content).includes(`${b} started by itself`)));
		await until(() => s.sent.some(({ message }) => String(message.content).includes(`Background subagent ${b}`)));
		expect(s.control.queued()).toEqual([]);
		expect(s.sent.map(({ message }) => String(message.content)).join("\n")).toContain("Started after agent:" + a);
		await s.control.stopAll();
	});

	it("holds B when A is stopped, lists it, and starts it on resume; stop cancels a waiting one", async () => {
		const s = setup();
		const first = await s.run({ task: "abortable work", goal: "first", background: true });
		const a = first.details.id as string;
		const held = await s.run({ task: "echo task held", goal: "second", background: true, after: [`agent:${a}`] });
		const cancelled = await s.run({ task: "echo task other", goal: "third", background: true, after: [`agent:${a}`] });
		expect(s.control.stop(cancelled.details.id as string, "user")).toBeUndefined();
		await until(() => s.control.queued().length === 1);
		expect(s.control.stop(a, "user")).toBeUndefined();
		await until(() => /held/.test(s.control.queued()[0] ?? ""));
		expect(s.control.queued()[0]).toContain(`${held.details.id} held`);
		expect(s.sent.map(({ message }) => String(message.content)).join("\n")).toContain("is held");
		const started = await s.run({ resume: held.details.id as string, task: "x", goal: "x" });
		expect(textOf(started)).toContain("Starting held");
		await until(() => s.control.queued().length === 0);
		await s.control.stopAll();
	});

	it("refuses after without background, and an unknown agent", async () => {
		const s = setup();
		await expect(s.run({ task: "t", after: ["B1"] })).rejects.toThrow(/after queues a background child/);
		await expect(s.run({ task: "t", background: true, after: ["agent:nobody"] })).rejects.toThrow(/not a child/);
	});
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));
