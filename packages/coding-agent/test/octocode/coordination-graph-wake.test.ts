import { withoutSourceHeader } from "../../src/octocode/shared/fence.ts";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import type * as NativeConfig from "../../src/config.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { checkDelegable } from "../../src/octocode/backlog/delegation.ts";
import { graphNotice } from "../../src/octocode/backlog/graph-notice.ts";
import { registerBacklogTool } from "../../src/octocode/native/tools/backlog/tool.ts";
import { USER_SENDER } from "../../src/octocode/shared/messages.ts";
import { MAX_SUBAGENTS_ENV } from "../../src/octocode/subagents/claim.ts";
import { GraphWake } from "../../src/octocode/subagents/graph-wake.ts";
import { itemLink } from "../../src/octocode/subagents/item-link.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { WAKE_INTERVAL_MS } from "../../src/octocode/team/wake-pace.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCachePolicy, fakeCtx, fakeHost, fakePermission, meteredBilling } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { backlogToolName } from "./backlog-fixture.ts";
import { registerBacklogPlanTool } from "../../src/octocode/native/tools/backlog-plan/tool.ts";

/**
 * USER DECISION 2 (2026-11-08): the coordination graph never stalls. However a prerequisite ends (done, closed, or its
 * owner child gone without finishing it) the coordinator hears what became ready or what is stuck, and a report that
 * carries such a notice wakes it, paced by `WakePace`. Also the c-graph reviewer findings on the phase-B graph fixes.
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
	const root = tmp("octocode-graph-wake-");
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
		"OCTOCODE_SUBAGENT_LINGER_SECONDS",
	])
		delete process.env[key];
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
	const cwd = fs.realpathSync(tmp("octocode-graph-wake-repo-"));
	const ctx = fakeCtx({ cwd });
	ctx.sessionManager.getSessionId = () => "session-test";
	return { cwd, ctx, backlog: openBacklog(ctx, { isSubagent: false }) };
}

/** The main session's `backlog` tool on `ctx`; `call` returns the result text. */
function backlogTool(ctx: ReturnType<typeof fakeCtx>) {
	const fake = fakeHost();
	const env = { OCTOCODE_AGENT_DB: process.env.OCTOCODE_AGENT_DB };
	registerBacklogTool(fake.api, { isSubagent: false, env, changed: () => undefined });
	registerBacklogPlanTool(fake.api, { isSubagent: false, env, changed: () => undefined });
	return async (params: Record<string, unknown>) =>
		(
			(await fake.tools
				.get(backlogToolName(params.op))
				.execute("c", { reason: "test", ...params }, undefined, undefined, ctx)) as {
				content: Array<{ text: string }>;
			}
		).content[0].text;
}

/** The `agent` tool of a main session. */
function agentTool() {
	const f = fakeHost();
	const team = new Team(f.api);
	const permission = fakePermission();
	const control = registerAgentTool(f.api, {
		profiles: () => new Map<string, AgentProfile>(),
		team,
		permission,
		refused: () => new Map(),
	});
	const cwd = fs.realpathSync(tmp("octocode-graph-wake-agent-"));
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
	const shutdown = async () => {
		await control.stopAll();
		await f.fire("session_shutdown", { type: "session_shutdown" }, ctx);
		team.stop();
	};
	return { ...f, ctx, run, control, team, shutdown, backlog: openBacklog(ctx, { isSubagent: false }) };
}

describe("(a) a prerequisite the coordinator completes itself, with no child report", () => {
	it("names the items that are now ready in the backlog update result", async () => {
		const { ctx } = mainBacklog();
		const call = backlogTool(ctx);
		await call({ op: "add", items: [{ ...READY, title: "api", state: "todo" }] });
		await call({ op: "add", items: [{ ...READY, title: "ui", state: "todo", dependsOn: ["B1"] }] });
		await call({ op: "claim", id: "B1" });
		const text = await call({ op: "done", id: "B1", completion: passed("own-1") });
		expect(text).toContain("B2 is ready to start: B1 was its last open prerequisite.");
	});
});

describe("(b) a prerequisite closed as obsolete or wont_do", () => {
	it("tells the coordinator which dependents are now ready and which still wait, when it closes it itself", async () => {
		const { ctx } = mainBacklog();
		const call = backlogTool(ctx);
		await call({ op: "add", items: [{ ...READY, title: "api", state: "todo" }] });
		await call({ op: "add", items: [{ ...READY, title: "other", state: "todo" }] });
		await call({ op: "add", items: [{ ...READY, title: "ui", state: "todo", dependsOn: ["B1"] }] });
		await call({ op: "add", items: [{ ...READY, title: "docs", state: "todo", dependsOn: ["B1", "B2"] }] });
		const text = await call({ op: "close", id: "B1", close: { kind: "obsolete", text: "superseded" } });
		expect(text).toContain("B1 is closed; B3 is now ready.");
		expect(text).toContain("B4 still waits on B2.");
	});

	it("rides in the report footer when the child closed its own item", async () => {
		const { ctx, backlog } = mainBacklog();
		backlog.store.add({ ...READY, title: "api", state: "todo", createdBy: "user" });
		backlog.store.add({ ...READY, title: "ui", state: "todo", createdBy: "user", dependsOn: ["B1"] });
		const link = itemLink(ctx, "B1")!;
		await link.claim();
		backlog.store.update("B1", { close: { kind: "wont_do", text: "not needed" } }, { id: "session-test" });
		const footer = await link.attach({ text: "closed", outcome: "done", usage: {} } as never, "worker-1");
		expect(footer).toContain("B1 is closed; B2 is now ready.");
		expect(footer).not.toContain("last open prerequisite");
		expect(link.notice).toContain("B1 is closed");
	});
});

describe("(c) a prerequisite whose owner child ended without finishing it", () => {
	it("names the waiting items and the choices, for a failed or stopped child (no report)", async () => {
		const { ctx, backlog } = mainBacklog();
		backlog.store.add({ ...READY, title: "api", state: "todo", createdBy: "user" });
		backlog.store.add({ ...READY, title: "ui", state: "todo", createdBy: "user", dependsOn: ["B1"] });
		backlog.store.add({ ...READY, title: "cli", state: "todo", createdBy: "user", dependsOn: ["B1"] });
		const link = itemLink(ctx, "B1")!;
		await link.claim();
		const footer = await link.attach(undefined, "worker-1");
		expect(footer).toMatch(
			/worker-1 ended its run on B1, which this session holds; (B2, B3|B3, B2) wait on it\. Mark B1 done once/,
		);
		expect(link.notice).toContain("worker-1 ended its run on B1");
	});

	it("keeps the owner-replacement wording when another session holds the item", async () => {
		const { backlog } = mainBacklog();
		backlog.store.add({ ...READY, title: "api", state: "todo", createdBy: "user" });
		backlog.store.add({ ...READY, title: "ui", state: "todo", createdBy: "user", dependsOn: ["B1"] });
		backlog.store.update("B1", { state: "ongoing" }, { id: "another-session" });
		expect(backlog.store.get("B1")?.assignee).toBe("another-session");
		const text = graphNotice(backlog, "B1", "worker-1");
		expect(text).toBe("B1's owner worker-1 ended; B2 waits on it: resume, reassign or close B1.");
	});

	it("says nothing when no open item depends on it", async () => {
		const { ctx, backlog } = mainBacklog();
		backlog.store.add({ ...READY, title: "api", state: "todo", createdBy: "user" });
		const link = itemLink(ctx, "B1")!;
		await link.claim();
		expect(await link.attach(undefined, "worker-1")).not.toContain("ended");
		expect(link.notice).toBeUndefined();
	});

	it("wakes the coordinator with the report of a child the user stopped, which would not wake it otherwise", async () => {
		const s = agentTool();
		try {
			s.backlog.store.add({ ...READY, title: "api", state: "todo", createdBy: "user" });
			s.backlog.store.add({ ...READY, title: "ui", state: "todo", createdBy: "user", dependsOn: ["B1"] });
			const first = await s.run({ task: "abortable work", item: "B1", background: true });
			const id = first.details.id as string;
			s.control.stop(id, USER_SENDER);
			await s.control.settle();
			const report = s.sent.find((entry) => {
				const text = withoutSourceHeader(String(entry.message.content));
				return text.startsWith(`Background subagent ${id} `) && text.includes("cancelled by the user");
			});
			expect(String(report?.message.content)).toContain(`B1's owner ${id} ended; B2 waits on it`);
			expect(report?.options.triggerTurn).toBe(true);
		} finally {
			await s.shutdown();
		}
	});
});

describe("(c) when the session itself stops every child", () => {
	it("forces no wake: plan mode, leaving and shutdown are the session's own act", async () => {
		const s = agentTool();
		try {
			s.backlog.store.add({ ...READY, title: "api", state: "todo", createdBy: "user" });
			s.backlog.store.add({ ...READY, title: "ui", state: "todo", createdBy: "user", dependsOn: ["B1"] });
			const first = await s.run({ task: "abortable work", item: "B1", background: true });
			const id = first.details.id as string;
			await s.control.stopAll("plan mode");
			const report = s.sent.find((entry) =>
				withoutSourceHeader(String(entry.message.content)).startsWith(`Background subagent ${id} `),
			);
			expect(String(report?.message.content)).toContain(`B1's owner ${id} ended`);
			expect(report?.options.triggerTurn).toBe(false);
		} finally {
			await s.shutdown();
		}
	});
});

describe("graph wakes are paced", () => {
	afterEach(() => vi.useRealTimers());

	it("lets a report carrying a graph notice wake once per interval and sends a refused one later as its own wake", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		const sent: string[] = [];
		const wake = new GraphWake((content) => sent.push(content));
		wake.start();
		expect(wake.wakes("plain", false)).toBe(false);
		expect(wake.wakes("waking", true)).toBe(true);
		wake.mark("a", "B2 is ready to start: B1 was its last open prerequisite.");
		expect(wake.wakes("a", false)).toBe(true);
		wake.mark("b", "B3's owner kid ended; B4 waits on it: resume, reassign or close B3.");
		// Within the interval: the report goes without a wake, and the notice follows as its own paced wake.
		expect(wake.wakes("b", false)).toBe(false);
		expect(sent).toEqual([]);
		await vi.advanceTimersByTimeAsync(WAKE_INTERVAL_MS);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("B3's owner kid ended");
		wake.stop();
	});

	it("never forces a wake while the session is shutting down", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		const sent: string[] = [];
		const wake = new GraphWake((content) => sent.push(content));
		wake.start();
		wake.mark("a", "notice a");
		wake.stop();
		expect(wake.wakes("a", false)).toBe(false);
		await vi.advanceTimersByTimeAsync(WAKE_INTERVAL_MS * 2);
		expect(sent).toEqual([]);
	});
});

describe("reviewer: a dependsOn that parses as an item ref in a batch add", () => {
	it("links the existing item, never an earlier entry that happens to carry that title", async () => {
		const { ctx } = mainBacklog();
		const call = backlogTool(ctx);
		await call({ op: "add", items: [{ ...READY, title: "existing" }] });
		const text = await call({
			op: "add",
			items: [
				{ ...READY, title: "B1" },
				{ ...READY, title: "ui", dependsOn: ["B1"] },
			],
		});
		expect(text).toMatch(/^Added 2 of 2\./);
		const backlog = openBacklog(ctx, { isSubagent: false });
		const ui = backlog.store.list({ title: "ui" }).items.find((item) => item.title === "ui")!;
		expect(ui.dependsOn.map((ref) => ref.id)).toEqual(["B1"]);
	});
});

describe("reviewer: delegating an item this session already holds", () => {
	it("is refused while one of its dependsOn items is open", () => {
		const { backlog } = mainBacklog();
		const actor = { id: "session-test" };
		backlog.store.add({ ...READY, title: "api", state: "todo", createdBy: "user" });
		backlog.store.add({ ...READY, title: "ui", state: "todo", createdBy: "user", dependsOn: ["B1"] });
		backlog.store.update("B1", { state: "ongoing" }, actor);
		backlog.store.update("B1", { state: "done", completion: passed("held-1") }, actor);
		backlog.store.update("B2", { state: "ongoing" }, actor);
		// The prerequisite was reopened after the claim (a regression turned up): the claim gate never sees that.
		backlog.store.update("B1", { state: "todo", note: "regression found" }, actor);
		expect(() => checkDelegable(backlog, "B2")).toThrow(/B2 waits on B1/);
	});
});

describe("reviewer: one item, one child", () => {
	it("starts only one of two calls on one item made in a single batch", async () => {
		const s = agentTool();
		try {
			s.backlog.store.add({ ...READY, title: "part", state: "todo", createdBy: "user" });
			const results = await Promise.allSettled([
				s.run({ task: "abortable work", item: "B1", background: true }),
				s.run({ task: "abortable work", item: "B1", background: true }),
			]);
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			const refused = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
			expect(String(refused?.reason)).toMatch(/B1 is being worked on by/);
		} finally {
			await s.shutdown();
		}
	});

	it("refuses a second child while the first lingers after its report, until that child is ended", async () => {
		const s = agentTool();
		try {
			s.backlog.store.add({ ...READY, title: "part", state: "todo", createdBy: "user" });
			const first = await s.run({ task: "linger blocked on a decision", item: "B1", background: true });
			const id = first.details.id as string;
			await s.control.settle();
			expect(s.control.running()).toEqual([]);
			await expect(s.run({ task: "report back", item: "B1", background: true })).rejects.toThrow(
				new RegExp(`B1 is with ${id}.*resume`),
			);
			// Ending its follow-up window frees the item for a new child.
			s.control.stop(id, "parent");
			await expect(s.run({ task: "report back", item: "B1" })).resolves.toBeDefined();
		} finally {
			await s.shutdown();
		}
	});
});

describe("plan view: the running child that owns each item", () => {
	it("shows the owning child on the backlog list row", async () => {
		const s = agentTool();
		try {
			s.backlog.store.add({ ...READY, title: "part", state: "todo", createdBy: "user" });
			s.backlog.store.add({ ...READY, title: "free", state: "todo", createdBy: "user" });
			const first = await s.run({ task: "abortable work", item: "B1", background: true });
			const id = first.details.id as string;
			const text = await backlogTool(s.ctx)({ op: "list" });
			const row = text.split("\n").find((line) => line.startsWith("B1 "));
			const free = text.split("\n").find((line) => line.startsWith("B2 "));
			expect(row).toContain(`(worked on by ${id})`);
			expect(free).not.toContain("worked on by");
		} finally {
			await s.shutdown();
		}
	});
});
