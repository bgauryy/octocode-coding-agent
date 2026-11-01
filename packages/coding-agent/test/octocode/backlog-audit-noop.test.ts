import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb, openAgentDb, sharedAgentDb } from "../../src/octocode/agentdb/db.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-audit-noop-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const REPO = "audit-repo";
const store = () => new BacklogStore(() => sharedAgentDb(), REPO);

/** The audit rows of the backlog row itself (not its notes, comments or links), by action. */
function itemAudits(ref: string): string[] {
	return (
		sharedAgentDb()
			.db.prepare(
				"SELECT action FROM backlog_audits WHERE repo_key = ? AND backlog_id = ? AND entity = 'backlog' ORDER BY id",
			)
			.all(REPO, ref) as Array<{ action: string }>
	).map((row) => row.action);
}

const base = { goal: "g", why: "Required work", createdBy: "agent" } as const;

describe("backlog audit rows carry a change", () => {
	it("writes no backlog row for a note-only update, yet bumps the version and keeps the note's own audit", () => {
		const s = store();
		s.add({ ...base, title: "one", state: "todo" });
		s.update("B1", { state: "ongoing" }, { id: "session-a" });
		const before = s.get("B1")!;
		const rows = itemAudits("B1").length;
		s.update("B1", { note: "progress" }, { id: "session-a" });
		expect(itemAudits("B1")).toHaveLength(rows);
		expect(s.get("B1")!.version).toBe(before.version + 1);
		expect(s.audit("B1").some((row) => row.entity === "backlog_comments")).toBe(true);
	});

	it("writes no row when the type is set to the one it has", () => {
		const s = store();
		s.add({ ...base, title: "one", state: "todo", type: "feature" });
		const rows = itemAudits("B1").length;
		s.update("B1", { type: "feature" }, { id: "session-a" });
		expect(itemAudits("B1")).toHaveLength(rows);
	});

	it("writes one row for an update that changes the parent and a field", () => {
		const s = store();
		s.add({ ...base, title: "epic", state: "todo", type: "epic" });
		s.add({ ...base, title: "child", state: "todo" });
		const rows = itemAudits("B2").length;
		s.update("B2", { parentId: "B1", title: "renamed child" }, { id: "session-a" });
		expect(itemAudits("B2")).toHaveLength(rows + 1);
		const after = s.audit("B2").find((row) => row.entity === "backlog" && row.action === "update")!.after;
		expect(after).toMatchObject({ title: "renamed child", parent_id: s.get("B1")!.rowId });
	});

	it("adds an item under an epic with its insert and one update row", () => {
		const s = store();
		s.add({ ...base, title: "epic", state: "todo", type: "epic" });
		s.add({ ...base, title: "child", state: "todo", type: "bug", parentId: "B1" });
		expect(itemAudits("B2")).toEqual(["insert", "update"]);
		expect(s.get("B2")).toMatchObject({ type: "bug", parentId: "B1" });
	});

	it("skips a no-op update an older build writes, and keeps the guard across reopening", () => {
		const s = store();
		s.add({ ...base, title: "one", state: "todo" });
		const rows = itemAudits("B1").length;
		const raw = sharedAgentDb().db;
		// What an older build's note-only update or same-value setter does.
		raw.prepare("UPDATE backlog SET version = version + 1, updated_at = updated_at + 1 WHERE repo_key = ?").run(REPO);
		raw.prepare("UPDATE backlog SET type = type WHERE repo_key = ?").run(REPO);
		expect(itemAudits("B1")).toHaveLength(rows);
		raw.prepare("UPDATE backlog SET title = 'changed' WHERE repo_key = ?").run(REPO);
		expect(itemAudits("B1")).toHaveLength(rows + 1);
		closeSharedAgentDb();
		openAgentDb(process.env.OCTOCODE_AGENT_DB).close();
		const triggers = sharedAgentDb()
			.db.prepare(
				"SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'backlog_audits_skip_noop'",
			)
			.get() as { n: number };
		expect(triggers.n).toBe(1);
	});

	it("files the legacy type rename as no change: reads already show `feature`", () => {
		const s = store();
		s.add({ ...base, title: "one", state: "todo" });
		const raw = sharedAgentDb().db;
		raw.prepare("UPDATE backlog SET type = 'task' WHERE repo_key = ?").run(REPO);
		const rows = itemAudits("B1").length;
		closeSharedAgentDb();
		expect(store().get("B1")!.type).toBe("feature");
		expect(itemAudits("B1")).toHaveLength(rows);
		expect(sharedAgentDb().db.prepare("SELECT type FROM backlog WHERE repo_key = ?").get(REPO)).toMatchObject({
			type: "feature",
		});
	});
});
