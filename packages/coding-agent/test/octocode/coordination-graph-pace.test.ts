import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { agentRuns, agents, closeSharedAgentDb, resolveAgent } from "../../../db/src/api.ts";
import type * as NativeConfig from "../../src/config.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { GRAPH_NOTICE_TYPE, USER_SENDER } from "../../src/octocode/shared/messages.ts";
import { MAX_SUBAGENTS_ENV } from "../../src/octocode/subagents/claim.ts";
import { GraphWake } from "../../src/octocode/subagents/graph-wake.ts";
import { GraphWatch } from "../../src/octocode/subagents/graph-watch.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";
import { registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { WAKE_INTERVAL_MS, WakePace } from "../../src/octocode/team/wake-pace.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerWakeRetry, WAKE_RETRY_MS } from "../../src/octocode/wake-retry.ts";
import { fixtureBacklog } from "./backlog-fixture.ts";
import { fakeCachePolicy, fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * USER DECISION 2 (2026-11-08): the coordination graph never stalls. The d-graph fixes on the c-graph review: a failed
 * graph-notice turn is retried, an owner that lingers is not called ended, stopAll quiets only the runs it stopped, held
 * notices go once a turn starts, graph and peer wakes share one pace, one liveness rule for "a live child run for an item",
 * and a prerequisite another session or the web board completes wakes the coordinator too.
 */

const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-fake-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };
const READY = { goal: "Expected result", why: "Required work" };
const PLANNED = { ...READY, createdBy: "agent", sourceSession: "session-test" };
const passed = (key: string) => ({
	summary: "Implemented",
	files: [],
	verification: { status: "passed" as const, summary: "Focused check passed" },
	operationKey: key,
});

beforeAll(() => {
	const root = tmp("octocode-graph-pace-");
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

afterEach(() => {
	vi.useRealTimers();
	closeSharedAgentDb();
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

/** The `agent` tool of a main session. */
function agentTool() {
	const f = fakeHost();
	const team = new Team(f.api);
	const control = registerAgentTool(
		f.api,
		() => new Map<string, AgentProfile>(),
		team,
		fakePermission(),
		() => new Map(),
	);
	const cwd = fs.realpathSync(tmp("octocode-graph-pace-agent-"));
	const ctx = fakeCtx({ cwd });
	Object.assign(ctx.ui, { confirm: async () => true });
	const models = [{ provider: "faux", id: "model", reasoning: true }];
	Object.assign(ctx, {
		model: models[0],
		modelRegistry: {
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

const reportOf = <T extends { message: { content: unknown } }>(sent: T[], id: string) =>
	sent.find((entry) => String(entry.message.content).startsWith(`Background subagent ${id} `));

describe("item 1: a graph notice that wakes the coordinator is retried like a report", () => {
	it("tries again when the turn it started fails at the provider", async () => {
		vi.useFakeTimers();
		const fake = fakeHost();
		registerWakeRetry(fake.api, false);
		const ctx = fakeCtx({ cwd: "/x", hasUI: true });
		await fake.emit(
			"before_agent_start",
			{ type: "before_agent_start", messageType: "custom", message: { customType: GRAPH_NOTICE_TYPE } },
			ctx,
		);
		await fake.emit(
			"agent_settled",
			{
				type: "agent_settled",
				aborted: false,
				outcome: { status: "failed", stopReason: "error", errorMessage: "503 Service Unavailable", usage: {} },
			},
			ctx,
		);
		await vi.advanceTimersByTimeAsync(WAKE_RETRY_MS[0]);
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
	});
});

describe("item 2: an owner that lingers after its report", () => {
	it("is said to stay reachable, not to have ended, with choices the lingering refusal allows", async () => {
		const s = agentTool();
		try {
			s.backlog.store.add({ ...READY, title: "api", state: "todo", createdBy: "user" });
			s.backlog.store.add({ ...READY, title: "ui", state: "todo", createdBy: "user", dependsOn: ["B1"] });
			const first = await s.run({ task: "linger blocked on a decision", item: "B1", background: true });
			const id = first.details.id as string;
			await s.control.settle();
			const text = String(reportOf(s.sent, id)?.message.content);
			expect(text).toContain(
				`${id} stopped working on B1 and stays reachable; B2 waits on it: resume it, or stop it and reassign, or close B1.`,
			);
			expect(text).not.toContain(`${id} ended`);
		} finally {
			await s.shutdown();
		}
	});
});

describe("item 3: stopAll quiets exactly the runs it stopped", () => {
	it("forces no wake for those ids, whenever their reports arrive, and still wakes for any other run", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		const sent: string[] = [];
		const wake = new GraphWake((content) => sent.push(content));
		wake.mark("a", "notice a");
		wake.mark("b", "notice b");
		wake.stopping(["a"]);
		expect(wake.wakes("a", false)).toBe(false);
		expect(wake.wakes("b", false)).toBe(true);
		await vi.advanceTimersByTimeAsync(WAKE_INTERVAL_MS * 2);
		expect(sent).toEqual([]);
	});

	it("keeps the notices it held and the pace across a stopAll (plan mode is not a shutdown)", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		const sent: string[] = [];
		const wake = new GraphWake((content) => sent.push(content));
		wake.mark("c", "notice c");
		expect(wake.wakes("c", false)).toBe(true);
		wake.mark("d", "notice d");
		expect(wake.wakes("d", false)).toBe(false);
		wake.stopping(["x"]);
		await vi.advanceTimersByTimeAsync(WAKE_INTERVAL_MS);
		expect(sent).toEqual(["notice d"]);
	});
});

describe("item 4: held notices and pace slots follow real idle turns", () => {
	it("drops a held notice once a coordinator turn starts: the report it rode in is read with that turn", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		const sent: string[] = [];
		const wake = new GraphWake((content) => sent.push(content));
		wake.mark("a", "notice a");
		expect(wake.wakes("a", false)).toBe(true);
		wake.mark("b", "notice b");
		expect(wake.wakes("b", false)).toBe(false);
		wake.turnStarted();
		await vi.advanceTimersByTimeAsync(WAKE_INTERVAL_MS * 2);
		expect(sent).toEqual([]);
	});

	it("records no pace slot for a wake while the coordinator is busy", () => {
		const pace = new WakePace();
		const wake = new GraphWake(
			() => undefined,
			() => false,
			pace,
		);
		wake.mark("a", "notice a");
		expect(wake.wakes("a", false)).toBe(true);
		expect(pace.allows()).toBe(true);
	});

	it("wakes for a notice with no report (a watched change) like a report's, paced", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		const sent: string[] = [];
		const wake = new GraphWake((content) => sent.push(content));
		wake.tell("first");
		wake.tell("second");
		expect(sent).toEqual(["first"]);
		wake.turnStarted();
		await vi.advanceTimersByTimeAsync(WAKE_INTERVAL_MS);
		expect(sent).toEqual(["first", "second"]);
	});
});

describe("item 8: graph and peer wakes share one pace", () => {
	it("refuses a graph wake right after a peer started a turn", async () => {
		const s = agentTool();
		try {
			s.backlog.store.add({ ...READY, title: "api", state: "todo", createdBy: "user" });
			s.backlog.store.add({ ...READY, title: "ui", state: "todo", createdBy: "user", dependsOn: ["B1"] });
			const first = await s.run({ task: "abortable work", item: "B1", background: true });
			const id = first.details.id as string;
			s.team.wakePace.record();
			s.control.stop(id, USER_SENDER);
			await s.control.settle();
			const report = reportOf(s.sent, id);
			expect(String(report?.message.content)).toContain("B2 waits on it");
			expect(report?.options.triggerTurn).toBe(false);
		} finally {
			await s.shutdown();
		}
	});
});

describe("item 6: one liveness rule for a live child run for an item", () => {
	it("resolves an item to the same agent the plan view names", () => {
		const db = openAgentDb(path.join(tmp("octocode-graph-pace-db-"), "agent.db"));
		try {
			const ws = "/w/live/.git";
			fixtureBacklog(() => db, ws).add({ ...READY, title: "part", state: "todo", createdBy: "user" });
			const place = { id: ws, binding: ws, name: "live", root: "/w/live" };
			const member = (id: string): Member => ({
				id,
				role: "main",
				pid: 100,
				started: "t0",
				status: "idle",
				joinedAt: 1,
				updatedAt: 1,
				toolCalls: 0,
				input: 0,
				cacheRead: 0,
				output: 0,
				cost: 0,
				unpriced: false,
			});
			agents.insert(db.db, "team", place, member("boss"));
			agents.insert(db.db, "team", place, member("alpha-fox"));
			agentRuns.begin(db.db, { workspaceId: ws, agentId: "alpha-fox", backlog: { workspaceId: ws, seq: 1 } }, 1_000);
			// Queued: its parent is a member, it has not joined yet.
			agentRuns.begin(
				db.db,
				{ workspaceId: ws, agentId: "beta-owl", parentAgentId: "boss", backlog: { workspaceId: ws, seq: 1 } },
				2_000,
			);
			const worker = agentRuns.openForItems(db.db, ws, [1])[0]?.agentId;
			expect(worker).toBe("beta-owl");
			expect(resolveAgent(db.db, "B1", ws)?.agentId).toBe(worker);
		} finally {
			db.close();
		}
	});
});

describe("item 7: a prerequisite completed outside this process wakes the coordinator", () => {
	function watched() {
		const cwd = fs.realpathSync(tmp("octocode-graph-pace-repo-"));
		const ctx = fakeCtx({ cwd });
		const backlog = openBacklog(ctx, { isSubagent: false });
		backlog.store.add({ ...PLANNED, title: "api", state: "todo" });
		backlog.store.add({ ...PLANNED, title: "ui", state: "todo", dependsOn: ["B1"] });
		const told: string[] = [];
		const linked = new Set<string>();
		let poke: (() => void) | undefined;
		const watch = new GraphWatch({
			backlog: () => backlog,
			linked: (ref) => linked.has(ref),
			tell: (notice) => told.push(notice),
			subscribe: (listener) => {
				poke = listener;
				return () => {
					poke = undefined;
				};
			},
		});
		watch.sync();
		return { backlog, told, linked, watch, poke: () => poke?.(), listening: () => poke !== undefined };
	}
	const other = { id: "other-session", surface: "tool" as const };

	it("tells the coordinator once when another session completes a prerequisite of an item it planned", () => {
		const w = watched();
		expect(w.listening()).toBe(true);
		w.backlog.store.update("B1", { state: "ongoing" }, other);
		w.backlog.store.update("B1", { state: "done", completion: passed("other-1") }, other);
		w.poke();
		expect(w.told).toEqual(["B2 is ready to start: B1 was its last open prerequisite."]);
		w.poke();
		expect(w.told).toHaveLength(1);
		// Nothing it planned waits any more: it stops following the database.
		expect(w.listening()).toBe(false);
	});

	it("tells it when the user closes a prerequisite on the web board", () => {
		const w = watched();
		w.backlog.store.update(
			"B1",
			{ close: { kind: "obsolete", text: "dropped" } },
			{ id: "session-test", kind: "human", surface: "web" },
		);
		w.poke();
		expect(w.told).toEqual(["B1 is closed; B2 is now ready."]);
	});

	it("stays quiet for its own backlog tool and for a child's item: their results carry the line", () => {
		const own = watched();
		own.backlog.store.update(
			"B1",
			{ close: { kind: "obsolete", text: "mine" } },
			{ id: "session-test", surface: "tool" },
		);
		own.poke();
		expect(own.told).toEqual([]);
		const child = watched();
		child.linked.add("B1");
		child.backlog.store.update(
			"B1",
			{ close: { kind: "wont_do", text: "child" } },
			{ id: "worker-1", surface: "tool" },
		);
		child.poke();
		expect(child.told).toEqual([]);
	});

	it("follows the database only while an item this session planned waits", () => {
		const cwd = fs.realpathSync(tmp("octocode-graph-pace-repo-"));
		const backlog = openBacklog(fakeCtx({ cwd }), { isSubagent: false });
		backlog.store.add({ ...READY, title: "api", state: "todo", createdBy: "user" });
		backlog.store.add({
			...READY,
			title: "ui",
			state: "todo",
			createdBy: "user",
			sourceSession: "elsewhere",
			dependsOn: ["B1"],
		});
		let listening = false;
		const watch = new GraphWatch({
			backlog: () => backlog,
			linked: () => false,
			tell: () => undefined,
			subscribe: () => {
				listening = true;
				return () => {
					listening = false;
				};
			},
		});
		watch.sync();
		expect(listening).toBe(false);
	});

	it("is wired into the agent tool: an outside completion sends a waking graph notice", async () => {
		const s = agentTool();
		try {
			s.backlog.store.add({ ...PLANNED, title: "api", state: "todo" });
			s.backlog.store.add({ ...PLANNED, title: "ui", state: "todo", dependsOn: ["B1"] });
			await s.fire("session_start", { type: "session_start", reason: "startup" }, s.ctx);
			s.backlog.store.update("B1", { close: { kind: "obsolete", text: "elsewhere" } }, other);
			await vi.waitFor(
				() => {
					const notice = s.sent.find((entry) => entry.message.customType === GRAPH_NOTICE_TYPE);
					expect(String(notice?.message.content)).toContain("B1 is closed; B2 is now ready.");
					expect(notice?.options.triggerTurn).toBe(true);
				},
				{ timeout: 5_000, interval: 100 },
			);
		} finally {
			await s.shutdown();
		}
	});
});
