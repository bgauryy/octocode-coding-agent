import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, agentRuns, itemRef, parseItemRef, resolveAgent } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { itemDetail } from "../../src/octocode/backlog/format.ts";
import { agentHookInput } from "../../src/octocode/hooks/register/agents.ts";
import type { AgentLifecycleNotice } from "../../src/octocode/shared/agent-lifecycle.ts";
import { agentDetailText, recentRunsText } from "../../src/octocode/subagents/run-text.ts";
import { fixtureBacklog } from "./backlog-fixture.ts";

const READY = { goal: "Expected result", why: "Required work" };
let root: string;
let db: AgentDb;
const ALPHA = "/w/alpha/.git";
const BETA = "/w/beta/.git";

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-links-")));
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", path.join(root, "agent.db"));
	db = openAgentDb();
});
afterEach(() => {
	db.close();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("a backlog item written from two workspaces", () => {
	function twoWorkspaces() {
		const alpha = fixtureBacklog(() => db, ALPHA);
		const beta = fixtureBacklog(() => db, BETA);
		for (const store of [alpha, beta]) store.add({ ...READY, title: "same number", state: "todo", createdBy: "user" });
		agentRuns.begin(db.db, {
			workspaceId: ALPHA,
			agentId: "alpha-fox",
			profile: "implementer",
			backlog: { workspaceId: ALPHA, seq: 1 },
		});
		agentRuns.begin(db.db, {
			workspaceId: BETA,
			agentId: "beta-owl",
			profile: "researcher",
			backlog: { workspaceId: BETA, seq: 1 },
		});
		return { alpha, beta };
	}

	it("is written B1 in its own workspace and <workspace name>:B1 in another, and both read back", () => {
		twoWorkspaces();
		expect(itemRef(db.db, ALPHA, 1, ALPHA)).toBe("B1");
		expect(itemRef(db.db, ALPHA, 1, BETA)).toBe("alpha:B1");
		expect(itemRef(db.db, BETA, 1, ALPHA)).toBe("beta:B1");
		expect(parseItemRef(db.db, "B1", ALPHA)).toEqual({ workspaceIds: [ALPHA], seq: 1 });
		expect(parseItemRef(db.db, "beta:b1", ALPHA)).toEqual({ workspaceIds: [BETA], seq: 1 });
		expect(parseItemRef(db.db, "alpha-fox", ALPHA)).toBeUndefined();
	});

	it("resolves to the agent of the item in the caller's workspace, or of the named one", () => {
		twoWorkspaces();
		expect(resolveAgent(db.db, "B1", ALPHA)?.agentId).toBe("alpha-fox");
		expect(resolveAgent(db.db, "B1", BETA)?.agentId).toBe("beta-owl");
		expect(resolveAgent(db.db, "alpha:B1", BETA)).toMatchObject({
			agentId: "alpha-fox",
			backlog: { ref: "alpha:B1", seq: 1 },
		});
		expect(resolveAgent(db.db, "beta:B1", ALPHA)).toMatchObject({ agentId: "beta-owl", backlog: { ref: "beta:B1" } });
		expect(resolveAgent(db.db, "B1", ALPHA)?.backlog?.ref).toBe("B1");
		expect(resolveAgent(db.db, "nowhere:B1", ALPHA)).toBeUndefined();
		expect(resolveAgent(db.db, "B2", ALPHA)).toBeUndefined();
		// Without the caller's workspace a bare B1 names no board, not whichever workspace has one.
		expect(parseItemRef(db.db, "B1")).toEqual({ workspaceIds: [], seq: 1 });
		expect(resolveAgent(db.db, "B1")).toBeUndefined();
	});

	it("lists, in `backlog get`, only the runs of this workspace's item: agent, how it ended, outcome and cost", () => {
		const { alpha, beta } = twoWorkspaces();
		agentRuns.finish(db.db, "alpha-fox", { endReason: "completed", outcome: "done" });
		const detail = (store: typeof alpha) =>
			itemDetail(store.get("B1")!, [], 0, Date.now(), { runs: store.runs(store.get("B1")!) });
		expect(detail(alpha)).toMatch(/Runs \(1\):\n- alpha-fox \(implementer\) completed .* · done · \$0\.000/);
		expect(detail(alpha)).not.toContain("beta-owl");
		expect(detail(beta)).toMatch(/Runs \(1\):\n- beta-owl \(researcher\) running · \$0\.000/);
		expect(detail(beta)).not.toContain("alpha-fox");
	});
});

describe("the text of /agents", () => {
	it("shows one agent's detail, ended or live, and a line per recent run", () => {
		agentRuns.begin(db.db, {
			workspaceId: fixtureBacklog(() => db, ALPHA).repo,
			agentId: "alpha-fox",
			profile: "implementer",
			goal: "fix the build",
			backlog: { workspaceId: ALPHA, seq: 3 },
		});
		agentRuns.finish(db.db, "alpha-fox", {
			endReason: "failed",
			endDetail: "provider error",
			outcome: "failed",
			reportPath: "/tmp/r.md",
		});
		const found = resolveAgent(db.db, "B3", ALPHA)!;
		const detail = agentDetailText(found);
		expect(detail).toContain("agent: alpha-fox (implementer) · ended");
		expect(detail).toContain("goal: fix the build");
		expect(detail).toContain("backlog: B3");
		expect(detail).toContain("ended: failed (provider error)");
		expect(detail).toContain("outcome: failed · report /tmp/r.md");
		const recent = recentRunsText(agentRuns.recent(db.db));
		expect(recent).toContain("alpha-fox (implementer) failed, failed");
		expect(recentRunsText([])).toBe("");
	});
});

describe("recent runs that have not ended", () => {
	const run = (agentId: string, kind: "main" | "child") =>
		({ agentId, kind, profile: undefined, startedAt: 0, endedAt: undefined, cost: 0, unpriced: false }) as never;

	it("say what a live agent is doing in the light's words, so an idle main session never reads running", () => {
		const words: Record<string, string> = { "main-aaaa": "idle", "kid-0001": "needs you" };
		const text = recentRunsText(
			[run("main-aaaa", "main"), run("kid-0001", "child"), run("gone-0002", "child")],
			1000,
			(r) => words[r.agentId],
		);
		expect(text).toContain("main-aaaa (main) idle ·");
		expect(text).toContain("kid-0001 (child) needs you ·");
		// A run nothing live answers for keeps the run record's word.
		expect(text).toContain("gone-0002 (child) running ·");
		expect(text).not.toContain("main-aaaa (main) running");
	});
});

describe("the AgentOn and AgentOff input, with what the run recorded", () => {
	const notice = (extra: Partial<AgentLifecycleNotice> = {}): AgentLifecycleNotice => ({
		seq: 5,
		kind: "off",
		agent: "alpha-fox",
		role: "implementer",
		parent: "main-owl",
		time: "2026-11-04T10:00:05.000Z",
		reason: "completed",
		data: {
			runId: "run-1",
			parentSessionId: "session-main",
			branch: "feature/audit",
			backlogItem: "alpha:B3",
			outcome: "done",
			filesChanged: { count: 25, paths: Array.from({ length: 25 }, (_, at) => `f${at}.ts`) },
		},
		...extra,
	});

	it("carries the run, parent session, branch, item, outcome and the first 20 changed files", () => {
		const input = agentHookInput(notice());
		expect(input).toMatchObject({
			run_id: "run-1",
			parent_session_id: "session-main",
			branch: "feature/audit",
			backlog_item: "alpha:B3",
			outcome: "done",
			files_changed: { count: 25 },
		});
		expect((input.files_changed as { paths: string[] }).paths).toHaveLength(20);
	});

	it("leaves what was not recorded null", () => {
		expect(agentHookInput(notice({ data: {} }))).toMatchObject({
			run_id: null,
			parent_session_id: null,
			branch: null,
			backlog_item: null,
			outcome: null,
			files_changed: null,
		});
	});
});
