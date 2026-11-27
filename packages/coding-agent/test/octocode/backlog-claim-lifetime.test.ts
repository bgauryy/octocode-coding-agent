import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspaceDb } from "../../src/storage/workspace-database.ts";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { backlogToolName } from "./backlog-fixture.ts";

const HOUR = 60 * 60 * 1000;
const READY = { goal: "Result can be checked", why: "Users need it" };

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-lifetime-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** A main session (or a subagent) named `session` working in the shared test repository. */
function setup(session = "session-a", isSubagent = false) {
	const fake = fakeHost();
	registerBacklog(fake.api, { commands: new Subcommands(), isSubagent });
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const base = fakeCtx({ cwd });
	const ctx = { ...base, sessionManager: { ...base.sessionManager, getSessionId: () => session } };
	const backlog = async (params: Record<string, unknown>) => {
		const result = (await fake.tools
			.get(backlogToolName(params.op))
			.execute("id", { reason: "test", ...params }, undefined, undefined, ctx)) as { content: Array<{ text: string }> };
		return result.content[0].text;
	};
	const start = (reason: string) => fake.fire("session_start", { type: "session_start", reason }, ctx);
	const shutdown = (reason: string) => fake.fire("session_shutdown", { type: "session_shutdown", reason }, ctx);
	return { backlog, start, shutdown, workspace: () => workspaceDb(cwd).workspace.id };
}

const row = (seq: number) =>
	workspaceDb(path.join(tmp, "repo"))
		.agent.db.prepare("SELECT state, assignee, updated_at FROM backlog WHERE seq = ?")
		.get(seq) as {
		state: string;
		assignee: string | null;
		updated_at: number;
	};

const notesOf = (seq: number) =>
	(
		workspaceDb(path.join(tmp, "repo"))
			.agent.db.prepare(
				"SELECT n.text FROM backlog_notes n JOIN backlog b ON b.id = n.item WHERE b.seq = ? ORDER BY n.id",
			)
			.all(seq) as Array<{ text: string }>
	).map((note) => note.text);

describe("claims follow the session that holds them", () => {
	it("V1: a graceful exit returns the session's own ongoing item to todo with a note", async () => {
		const t = setup();
		await t.backlog({ op: "add", items: [{ ...READY, title: "Mine", state: "ongoing" }] });
		await t.backlog({ op: "add", items: [{ ...READY, title: "Not claimed", state: "todo" }] });
		expect(row(1)).toMatchObject({ state: "ongoing", assignee: "session-a" });
		await t.shutdown("quit");
		expect(row(1)).toMatchObject({ state: "todo", assignee: null });
		expect(notesOf(1).at(-1)).toBe("Returned to todo: holder session-a ended. Resuming session-a restores it.");
		expect(notesOf(2)).toEqual([]);
	});

	it("keeps the claim on reload, in a subagent, with a child run open and for another session's item", async () => {
		const t = setup();
		await t.backlog({ op: "add", items: [{ ...READY, title: "Reloaded", state: "ongoing" }] });
		await t.backlog({ op: "add", items: [{ ...READY, title: "Delegated", state: "ongoing" }] });
		const db = workspaceDb(path.join(tmp, "repo")).agent.db;
		db.prepare(
			"INSERT INTO agents (id, team, workspace_id, role, pid, status, joined_at, seen_at) VALUES ('kid-1', 't', ?, 'child', 1, 'idle', 0, 0)",
		).run(t.workspace());
		db.prepare(
			"INSERT INTO agent_runs (run_id, workspace_id, agent_id, kind, backlog_workspace, backlog_seq, started_at) VALUES ('run-1', ?, 'kid-1', 'child', ?, 2, 0)",
		).run(t.workspace(), t.workspace());
		db.prepare(
			"INSERT INTO backlog (workspace_id, seq, title, state, assignee, created_by, created_at, updated_at) VALUES (?, 3, 'Theirs', 'ongoing', 'session-b', 'user', 0, ?)",
		).run(t.workspace(), Date.now());
		await t.shutdown("reload");
		expect(row(1).state).toBe("ongoing");
		await setup("session-a", true).shutdown("quit");
		expect(row(1).state).toBe("ongoing");
		await t.shutdown("quit");
		expect(row(1).state).toBe("todo");
		expect(row(2)).toMatchObject({ state: "ongoing", assignee: "session-a" });
		expect(row(3)).toMatchObject({ state: "ongoing", assignee: "session-b" });
	});

	it("V2: resuming the session restores an untouched item, and leaves one someone else touched", async () => {
		const t = setup();
		await t.backlog({ op: "add", items: [{ ...READY, title: "Untouched", state: "ongoing" }] });
		await t.backlog({ op: "add", items: [{ ...READY, title: "Touched", state: "ongoing" }] });
		await t.shutdown("quit");
		await new Promise((resolve) => setTimeout(resolve, 5));
		await setup("session-b").backlog({ op: "edit", items: [{ id: "B2", priority: "p0" }] });
		expect(row(2).state).toBe("todo");
		await t.start("resume");
		expect(row(1)).toMatchObject({ state: "ongoing", assignee: "session-a" });
		expect(notesOf(1).at(-1)).toBe("Restored: holder session-a resumed.");
		expect(row(2)).toMatchObject({ state: "todo", assignee: null });
		expect(notesOf(2).at(-1)).not.toMatch(/Restored/);
	});

	it("restores on a continued start of the same session, not for another session or a claim taken meanwhile", async () => {
		const t = setup();
		await t.backlog({ op: "add", items: [{ ...READY, title: "Mine", state: "ongoing" }] });
		await t.backlog({ op: "add", items: [{ ...READY, title: "Taken", state: "ongoing" }] });
		await t.shutdown("quit");
		await setup("session-b").start("resume");
		expect(row(1).state).toBe("todo");
		await setup("session-b").backlog({ op: "claim", id: "B2", ...READY });
		await t.start("startup");
		expect(row(1)).toMatchObject({ state: "ongoing", assignee: "session-a" });
		expect(row(2).assignee).toBe("session-b");
	});

	it("V3: a killed holder's claim idle 25 hours is returned at session start; 23 hours is not", async () => {
		const t = setup("session-new");
		const held = (seq: number, hours: number) =>
			workspaceDb(path.join(tmp, "repo"))
				.agent.db.prepare(
					"INSERT INTO backlog (workspace_id, seq, title, state, assignee, created_by, created_at, updated_at) VALUES (?, ?, ?, 'ongoing', 'killed-session', 'user', 0, ?)",
				)
				.run(t.workspace(), seq, `Idle ${hours}h`, Date.now() - hours * HOUR);
		held(10, 25);
		held(11, 23);
		await t.start("startup");
		expect(row(10)).toMatchObject({ state: "todo", assignee: null });
		expect(notesOf(10).at(-1)).toBe(
			"Returned to todo: holder killed-session ended and the claim sat idle for over 24 hours.",
		);
		expect(row(11)).toMatchObject({ state: "ongoing", assignee: "killed-session" });
	});

	it("V4: listing changes nothing, and still marks a claim whose holder ended", async () => {
		const t = setup();
		workspaceDb(path.join(tmp, "repo"))
			.agent.db.prepare(
				"INSERT INTO backlog (workspace_id, seq, title, state, assignee, created_by, created_at, updated_at) VALUES (?, 5, 'Old claim', 'ongoing', 'killed-session', 'user', 0, ?)",
			)
			.run(t.workspace(), Date.now() - 30 * 24 * HOUR);
		const before = { row: row(5), notes: notesOf(5) };
		const first = await t.backlog({ op: "list", states: ["ongoing"] });
		await t.backlog({ op: "list" });
		await t.backlog({ op: "get", id: "B5" });
		expect(first).toContain("B5 [ongoing p2] Old claim (@killed-session) (stale: holder ended)");
		expect({ row: row(5), notes: notesOf(5) }).toEqual(before);
	});
});
