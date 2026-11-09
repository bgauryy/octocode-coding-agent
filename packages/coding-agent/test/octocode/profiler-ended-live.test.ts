import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentDb, sessions } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { WorkspaceRuntime } from "../../src/octocode/workspace/runtime.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { fixtureBacklog } from "./backlog-fixture.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const T = Date.UTC(2026, 10, 8, 10, 0, 0);
let dir: string;
let db: AgentDb;
let store: TeamStore;

const reply = (ms: number) =>
	JSON.stringify({
		id: `r${ms}`,
		parentId: null,
		timestamp: new Date(T + ms).toISOString(),
		type: "message",
		message: {
			role: "assistant",
			content: "x",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			timestamp: T + ms - 500,
			durationMs: 500,
			usage: { output: 1, input: 10, cacheRead: 0, cacheWrite: 30_000, cost: { total: 0.25 } },
		},
	});
const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "main",
	pid: process.pid,
	status: "working",
	joinedAt: Date.now(),
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "profiler-ended-live-"));
	db = openAgentDb(path.join(dir, "db"));
	store = TeamStore.open(dir, db.file);
});
afterEach(() => {
	store.close();
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the live profiler after a subagent finished", () => {
	it("keeps the ended child, its requests and its outcome, after the live members", () => {
		const kidFile = path.join(dir, "kid.jsonl");
		fs.writeFileSync(kidFile, `${reply(3000)}\n`);
		sessions.saveCatalog(db.db, "sess-kid", {
			title: null,
			titleSource: null,
			cwd: dir,
			file: kidFile,
			parentFile: null,
			createdAt: T,
			lastActive: T,
			messageCount: 1,
			firstPrompt: null,
			fileMtime: null,
		});
		// The session under test is the fake context's "session-test": a coordinator and one child that has left.
		store.lifecycle = { activationId: "a1", sessionId: "session-test" };
		store.join(member("steady-main"));
		store.lifecycle = { activationId: "a2", sessionId: "sess-kid" };
		store.join(member("quick-finch", { role: "researcher", parentId: "steady-main", goal: "find the callers" }));
		store.remove("quick-finch");

		const live = member("busy-owl", { role: "general", parentId: "steady-main" });
		const fake = fakeHost();
		const runtime = new WorkspaceRuntime(fake.api, {
			database: () => db,
			members: () => [live],
			traffic: () => [],
			self: () => member("steady-main"),
			tell: async () => ({ sent: [], id: 1 }),
			stop: () => undefined,
		});
		const backlog = {
			store: fixtureBacklog(() => db, "repo"),
			actor: { id: "session-test" },
			session: "session-test",
			repoName: "repo",
			repoRoot: dir,
		};
		const profiler = runtime.bind(fakeCtx({ cwd: dir }), backlog).profiler!;

		const agents = profiler.agents().agents;
		expect(agents.map((agent) => agent.id)).toEqual(["steady-main", "busy-owl", "quick-finch"]);
		const ended = agents.find((agent) => agent.id === "quick-finch")!;
		expect(ended).toMatchObject({ role: "researcher", requests: 1, profiled: true, parentId: "steady-main" });
		expect(ended.outcome).toEqual(expect.any(String));
		expect(ended.totals.cost).toBeCloseTo(0.25);
		expect(agents.find((agent) => agent.id === "busy-owl")!.outcome).toBeUndefined();
		expect(profiler.requests("quick-finch")?.requests).toHaveLength(1);
		expect(profiler.timeline().events.some((event) => event.agentId === "quick-finch" && event.kind === "exit")).toBe(
			true,
		);
	});
});
