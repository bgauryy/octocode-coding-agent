import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import type * as NativeConfig from "../../src/config.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { checkDelegable } from "../../src/octocode/backlog/delegation.ts";
import { MAX_SUBAGENTS_ENV } from "../../src/octocode/subagents/claim.ts";
import { itemLink } from "../../src/octocode/subagents/item-link.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { conditionChecker } from "../../src/octocode/timer/condition.ts";
import { parseUntil } from "../../src/octocode/timer/conditions/index.ts";
import { timerFields } from "../../src/octocode/timer/model.ts";
import type { ConditionDeps } from "../../src/octocode/timer/conditions/types.ts";
import { fakeCachePolicy, fakeCtx, fakeHost, fakePermission, meteredBilling } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { registerBacklogPlanTool } from "../../src/octocode/backlog/plan-tool.ts";

/**
 * The mechanisms under the coordinator's planning graph (`instructions/policy/delegation.md`): one item per part with an
 * owner, real `dependsOn` links, a graph checked before it starts and run in waves. Each case asks whether the backlog,
 * the `agent` tool and the `timer` support what that policy tells the main session to do.
 */

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };
const READY = { goal: "Expected result", why: "Required work" };
const passed = (key: string) => ({
	summary: "Implemented",
	files: [],
	verification: { status: "passed" as const, summary: "Focused check passed" },
	operationKey: key,
});

beforeAll(() => {
	const root = tmp("octocode-graph-edge-");
	process.env.OCTOCODE_HOME = path.join(root, "home");
	process.env.OCTOCODE_AGENT_DB = path.join(root, "team", "team.sqlite");
	for (const key of [
		MAX_SUBAGENTS_ENV,
		"OCTOCODE_SUBAGENT",
		"OCTOCODE_AGENT_ID",
		"OCTOCODE_PARENT_ID",
		"OCTOCODE_AGENT_GOAL",
		"OCTOCODE_AGENT_SCRATCH",
		"OCTOCODE_TEAM_WORKSPACE",
		"OCTOCODE_PARENT_SESSION",
		"OCTOCODE_BACKLOG_ITEM",
	])
		delete process.env[key];
	// The agent tool re-runs the current `octocode` script: point it at the scripted stand-in.
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
});

afterAll(() => {
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

afterEach(() => closeSharedAgentDb());

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

/** A main session's backlog in a fresh checkout, as `session-test`. */
function mainBacklog() {
	const cwd = fs.realpathSync(tmp("octocode-graph-repo-"));
	const ctx = fakeCtx({ cwd });
	ctx.sessionManager.getSessionId = () => "session-test";
	return { cwd, ctx, backlog: openBacklog(ctx, { isSubagent: false }) };
}

/** The `agent` tool of a main session, with its spawn approvals recorded. */
function agentTool() {
	const f = fakeHost();
	const team = new Team(f.api);
	const permission = fakePermission();
	const asked: Array<string | undefined> = [];
	const check = permission.check.bind(permission);
	vi.spyOn(permission, "check").mockImplementation(async (ctx, request) => {
		asked.push(request.action);
		return check(ctx, request);
	});
	const control = registerAgentTool(f.api, {
		profiles: () => new Map<string, AgentProfile>(),
		team,
		permission,
		refused: () => new Map(),
	});
	const cwd = fs.realpathSync(tmp("octocode-graph-agent-"));
	const ctx = fakeCtx({ cwd });
	Object.assign(ctx.ui, { confirm: async () => true });
	const models = [{ provider: "faux", id: "model", reasoning: true }];
	Object.assign(ctx, {
		model: models[0],
		modelRegistry: {
			...meteredBilling,
			getAvailable: () => models,
			find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
			getCachePolicy: fakeCachePolicy,
			getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
		},
	});
	team.start(ctx);
	const agent = f.tools.get("agent");
	const run = (params: Record<string, unknown>) =>
		agent.execute("call-1", { goal: "graph part", ...params }, undefined, undefined, ctx) as Promise<{
			content: Array<{ text: string }>;
			details: Record<string, unknown>;
		}>;
	return { ...f, ctx, run, asked, control, backlog: openBacklog(ctx, { isSubagent: false }) };
}

describe("a dependsOn cycle", () => {
	it("is refused for a pure dependency loop and a self-dependency, leaving the links as they were", () => {
		const { backlog } = mainBacklog();
		const actor = { id: "session-test" };
		const a = backlog.store.add({ ...READY, title: "a", state: "todo", createdBy: "user" });
		const b = backlog.store.add({ ...READY, title: "b", state: "todo", createdBy: "user", dependsOn: [a.ref] });
		expect(() => backlog.store.update(a.ref, { dependsOn: [b.ref] }, actor)).toThrow(/waiting cycle/);
		expect(() => backlog.store.update(a.ref, { dependsOn: [a.ref] }, actor)).toThrow(/waiting cycle/);
		expect(backlog.store.get(a.ref)!.dependsOn).toEqual([]);
	});
});

describe("a task started for an item whose dependsOn is not done", () => {
	it("is refused by the delegation check itself, naming the open prerequisite, before anything is claimed", () => {
		const { backlog } = mainBacklog();
		backlog.store.add({ ...READY, title: "api", state: "todo", createdBy: "user" });
		backlog.store.add({ ...READY, title: "ui", state: "todo", createdBy: "user", dependsOn: ["B1"] });
		// Today checkDelegable returns { claimable: true } and only the claim, after the spawn approval, refuses it.
		expect(() => checkDelegable(backlog, "B2")).toThrow(/B2 waits on B1/);
		expect(backlog.store.get("B2")!.state).toBe("todo");
	});

	it("is refused before the user is asked to approve the spawn", async () => {
		const s = agentTool();
		s.backlog.store.add({ ...READY, title: "api", state: "todo", createdBy: "user" });
		s.backlog.store.add({ ...READY, title: "ui", state: "todo", createdBy: "user", dependsOn: ["B1"] });
		await expect(s.run({ task: "report back", item: "B2" })).rejects.toThrow(/B1/);
		// The approval prompt is the cost the refusal must come before (spawn.ts asks at askSpawn, claims after it).
		expect(s.asked).not.toContain("agent.spawn");
		expect(s.control.running()).toEqual([]);
	});
});

describe("one item, one child", () => {
	it("refuses a second child on an item a running child of this session already works on", async () => {
		const s = agentTool();
		s.backlog.store.add({ ...READY, title: "part", state: "todo", createdBy: "user" });
		const first = await s.run({ task: "abortable work", item: "B1", background: true });
		const id = first.details.id as string;
		try {
			await expect(s.run({ task: "report back", item: "B1" })).rejects.toThrow(new RegExp(`B1.*${id}`));
		} finally {
			await s.fire("session_shutdown", { type: "session_shutdown" }, s.ctx);
		}
	});
});

describe("a dependency finishing", () => {
	it("tells the parent, with the child's report, which dependent items are now ready", () => {
		const { ctx, backlog } = mainBacklog();
		const actor = { id: "session-test" };
		backlog.store.add({ ...READY, title: "api", state: "todo", createdBy: "user" });
		backlog.store.add({ ...READY, title: "ui", state: "todo", createdBy: "user", dependsOn: ["B1"] });
		backlog.store.add({ ...READY, title: "docs", state: "todo", createdBy: "user", dependsOn: ["B1", "B2"] });
		const link = itemLink(ctx, "B1")!;
		link.claim();
		// The child closes its item with a passing check, then reports.
		backlog.store.update("B1", { state: "done", completion: passed("k1") }, actor);
		const footer = link.attach({ text: "done", outcome: "done", usage: {} } as never, "worker-1");
		expect(footer).toContain("Noted on B1.");
		// B2 waited only on B1 and is now free to start; B3 still waits on B2.
		expect(footer).toMatch(/B2 is ready/);
		expect(footer).not.toMatch(/B3 is ready/);
	});

	it("names several newly ready items in one line, and none while the dependency is not done", () => {
		const { ctx, backlog } = mainBacklog();
		const actor = { id: "session-test" };
		backlog.store.add({ ...READY, title: "api", state: "todo", createdBy: "user" });
		backlog.store.add({ ...READY, title: "ui", state: "todo", createdBy: "user", dependsOn: ["B1"] });
		backlog.store.add({ ...READY, title: "cli", state: "todo", createdBy: "user", dependsOn: ["B1"] });
		const link = itemLink(ctx, "B1")!;
		link.claim();
		expect(link.attach({ text: "partial", outcome: "partial", usage: {} } as never, "worker-1")).not.toMatch(/ready/);
		backlog.store.update("B1", { state: "done", completion: passed("k2") }, actor);
		// In board order: the most urgent first, then the most recently updated.
		expect(link.attach({ text: "done", outcome: "done", usage: {} } as never, "worker-1")).toMatch(
			/(B2, B3|B3, B2) are ready to start: B1 was their last open prerequisite\./,
		);
	});
});

describe("a graph planned in one backlog add", () => {
	it("links an entry to an earlier entry of the same add by its title", async () => {
		const { ctx } = mainBacklog();
		const env = { OCTOCODE_AGENT_DB: process.env.OCTOCODE_AGENT_DB };
		const fake = fakeHost();
		registerBacklogPlanTool(fake.api, { isSubagent: false, env, changed: () => undefined });
		const tool = fake.tools.get("backlogPlan");
		// Earlier work holds B1: the new items' numbers are assigned on insert, so the plan cannot name them in advance.
		await tool.execute(
			"c0",
			{ op: "add", reason: "earlier", items: [{ ...READY, title: "old" }] },
			undefined,
			undefined,
			ctx,
		);
		const result = (await tool.execute(
			"c1",
			{
				op: "add",
				reason: "plan the graph",
				items: [
					{ ...READY, title: "api types", paths: ["src/api.ts"] },
					{ ...READY, title: "ui", paths: ["src/ui.ts"], dependsOn: ["api types"] },
				],
			},
			undefined,
			undefined,
			ctx,
		)) as { content: Array<{ text: string }> };
		expect(result.content[0].text).toMatch(/^Added 2 of 2\./);
		const backlog = openBacklog(ctx, { isSubagent: false });
		const ui = backlog.store.list({ title: "ui" }).items.find((item) => item.title === "ui")!;
		const [api] = backlog.store.list({ title: "api types" }).items;
		expect(ui.dependsOn.map((ref) => ref.id)).toEqual([api?.ref]);
	});

	it("leaves a title that names no earlier added entry as it is, so the entry is refused", async () => {
		const { ctx } = mainBacklog();
		const env = { OCTOCODE_AGENT_DB: process.env.OCTOCODE_AGENT_DB };
		const fake = fakeHost();
		registerBacklogPlanTool(fake.api, { isSubagent: false, env, changed: () => undefined });
		const result = (await fake.tools.get("backlogPlan").execute(
			"c1",
			{
				op: "add",
				reason: "plan",
				items: [
					{ ...READY, title: "ui", dependsOn: ["api types"] },
					{ ...READY, title: "api types" },
				],
			},
			undefined,
			undefined,
			ctx,
		)) as { content: Array<{ text: string }> };
		// Only an earlier entry counts: a later one has no ref yet when this entry is added.
		expect(result.content[0].text).toMatch(/^Added 1 of 2; 1 refused\./);
		expect(result.content[0].text).toContain('"ui": refused');
	});
});

describe("a timer waiting until an item is done", () => {
	const deps = (state: string): ConditionDeps => ({
		reservation: () => undefined,
		context: () => undefined,
		item: () => state,
		blockers: () => [],
		agentEnd: () => undefined,
		watchDatabase: () => () => undefined,
		judge: async () => ({ verdict: "skipped", reason: "none" }),
	});
	const input = { cwd: "/", baseline: undefined } as never;

	it("ends when the item is closed instead, rather than waiting out its deadline", async () => {
		const until = parseUntil({ item: { ref: "B4", state: "done" } })!;
		const outcome = await conditionChecker(deps("closed"))(until, input);
		// A closed item never becomes done without being reopened: the waiter must hear it now, not in an hour.
		expect(outcome.met || outcome.refused !== undefined).toBe(true);
		expect(`${outcome.output} ${outcome.refused ?? ""}`).toContain("B4 is closed");
	});

	it("has a fallback: without a deadline of its own it ends after an hour, so a wait on an abandoned item is bounded", () => {
		const owner = { workspaceId: "w", sessionId: "s1", cwd: "/" };
		const fields = timerFields({ note: "start B5", until: { item: { ref: "B4", state: "done" } } }, 1_000, owner);
		expect(fields).toMatchObject({ kind: "until", deadlineAt: 1_000 + 3_600_000 });
	});
});
