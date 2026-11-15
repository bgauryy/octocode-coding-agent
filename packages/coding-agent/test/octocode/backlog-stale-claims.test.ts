import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { backlogToolName } from "./backlog-fixture.ts";

const DAY = 24 * 60 * 60 * 1000;

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-stale-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function setup() {
	const fake = fakeHost();
	registerBacklog(fake.api, { commands: new Subcommands(), isSubagent: false });
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const ctx = fakeCtx({ cwd });
	const backlog = async (params: Record<string, unknown>) => {
		const result = (await fake.tools
			.get(backlogToolName(params.op))
			.execute("id", { reason: "test", ...params }, undefined, undefined, ctx)) as { content: Array<{ text: string }> };
		return result.content[0].text;
	};
	const start = (reason: string) => fake.fire("session_start", { type: "session_start", reason }, ctx);
	const workspace = () => registeredWorkspace(cwd).id;
	/** An ongoing item held by `holder`, last touched `idleDays` ago. */
	const held = (seq: number, title: string, holder: string, idleDays: number) =>
		sharedAgentDb()
			.db.prepare(
				"INSERT INTO backlog (workspace_id, seq, title, state, assignee, created_by, created_at, updated_at) VALUES (?, ?, ?, 'ongoing', ?, 'user', 0, ?)",
			)
			.run(workspace(), seq, title, holder, Date.now() - idleDays * DAY);
	/** A session whose recorded process runs: the parent of this test process. */
	const liveSession = (id: string) =>
		sharedAgentDb().db.prepare("INSERT INTO sessions (id, pid) VALUES (?, ?)").run(id, process.ppid);
	return { backlog, held, liveSession, start, workspace };
}

describe("claims of ended sessions", () => {
	it("returns an idle ended holder's item to todo at a fresh session's start, with a note naming it, and leaves live and recent claims", async () => {
		const t = setup();
		t.liveSession("live-session");
		t.held(10, "Abandoned", "ended-session", 30);
		t.held(11, "Held live", "live-session", 30);
		t.held(12, "Ended recently", "ended-session", 0);
		await t.start("startup");
		const text = await t.backlog({ op: "list", states: ["ongoing"] });
		expect(text).not.toContain("B10 [ongoing");
		expect(text).toContain("B11 [ongoing p2] Held live (@live-session)");
		expect(text).not.toContain("B11 [ongoing p2] Held live (@live-session) (stale");
		expect(text).toContain("B12 [ongoing p2] Ended recently (@ended-session) (stale: holder ended)");
		const todo = await t.backlog({ op: "list", states: ["todo"] });
		expect(todo).toContain("B10 [todo p2] Abandoned");
		expect(todo).not.toContain("(@ended-session)");
		const notes = await t.backlog({ op: "get", id: "B10" });
		expect(notes).toContain("ended-session");
		expect(notes).toMatch(/Returned to todo/);
	});

	it("keeps the item of an ended holder while a child run on it is open", async () => {
		const t = setup();
		t.held(20, "Child still working", "ended-session", 30);
		const db = sharedAgentDb().db;
		db.prepare(
			"INSERT INTO agents (id, team, workspace_id, role, pid, status, joined_at, seen_at) VALUES ('kid-1', 't', ?, 'child', 1, 'idle', 0, 0)",
		).run(t.workspace());
		db.prepare(
			"INSERT INTO agent_runs (run_id, workspace_id, agent_id, kind, backlog_workspace, backlog_seq, started_at) VALUES ('run-1', ?, 'kid-1', 'child', ?, 20, 0)",
		).run(t.workspace(), t.workspace());
		const text = await t.backlog({ op: "list", states: ["ongoing"] });
		expect(text).toContain("B20 [ongoing");
	});
});
