import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentDb, backlog, history, openDatabase, workspaces } from "../src/api.ts";
import { tmp } from "./helpers.ts";

let agent: AgentDb;
beforeEach(() => {
	const dir = tmp();
	agent = openDatabase({
		file: path.join(dir, "agent.db"),
		mirrorFile: path.join(dir, "transcripts.db"),
		archiveDir: path.join(dir, "archive"),
		privateParent: false,
	});
	workspaces.register(agent.db, { id: "ws", name: "test", root: "/test", binding: "1:1" });
	workspaces.register(agent.db, { id: "other", name: "other", root: "/other", binding: "1:2" });
});
afterEach(() => agent.close());

const ITEM = { goal: "g", body: "", paths: "", why: "w", evidence: "", plan: "", tags: "", createdBy: "u" };

function add(repo: string, seq: number, state = "todo", actor = { id: "s1", surface: "tool" }): number {
	agent.withActor(actor, () =>
		backlog.insertItem(agent.db, {
			...ITEM,
			repo,
			seq,
			title: `Item ${seq}`,
			state,
			priority: 2,
			sourceSession: null,
			at: seq,
			fromItem: null,
			type: "feature",
		}),
	);
	return (
		agent.db.prepare("SELECT id FROM backlog WHERE workspace_id = ? AND seq = ?").get(repo, seq) as { id: number }
	).id;
}

function claim(rowId: number, assignee: string | null, state: string, actor: { id: string; surface: string }): void {
	agent.withActor(actor, () =>
		backlog.saveItem(agent.db, rowId, {
			...ITEM,
			title: "Renamed",
			state,
			priority: 2,
			assignee,
			at: 99,
			startedAt: null,
			doneAt: null,
			fromItem: null,
			closed: null,
		}),
	);
}

describe("backlog task source queries", () => {
	it("snapshot returns the open rows with versions and the newest audit id of the workspace as the cursor", () => {
		expect(backlog.snapshot(agent.db, "ws")).toEqual({ cursor: 0, items: [] });
		const one = add("ws", 1);
		add("ws", 2, "done");
		add("other", 1);
		claim(one, "s1", "ongoing", { id: "s1", surface: "tool" });
		const snap = backlog.snapshot(agent.db, "ws");
		const newest = Number(backlog.auditRows(agent.db, "ws", undefined, undefined, 1)[0].id);
		expect(snap.cursor).toBe(newest);
		expect(snap.items).toEqual([
			{
				seq: 1,
				version: 2,
				state: "ongoing",
				assignee: "s1",
				title: "Renamed",
				goal: "g",
				priority: 2,
				parent_seq: null,
			},
		]);
	});

	it("auditAfter returns this workspace's rows after the cursor, oldest first, with the item fields after the change", () => {
		const one = add("ws", 1);
		const cursor = backlog.snapshot(agent.db, "ws").cursor;
		add("other", 1);
		claim(one, "s2", "ongoing", { id: "s2", surface: "web" });
		add("ws", 2);
		const page = backlog.auditAfter(agent.db, "ws", cursor, 1);
		if (page.resync) throw new Error("unexpected resync");
		expect(page.rows).toHaveLength(1);
		expect(page.rows[0]).toMatchObject({
			backlog_id: "B1",
			action: "update",
			entity: "backlog",
			version: 2,
			state: "ongoing",
			assignee: "s2",
			before_assignee: null,
			title: "Renamed",
			closed: 0,
		});
		expect(JSON.parse(page.rows[0].actor)).toEqual({ id: "s2", surface: "web" });
		expect(page.more).toBe(true);
		expect(page.cursor).toBe(page.rows[0].id);
		const rest = backlog.auditAfter(agent.db, "ws", page.cursor, 10);
		if (rest.resync) throw new Error("unexpected resync");
		expect(rest.rows.map((row) => [row.backlog_id, row.action])).toEqual([["B2", "insert"]]);
		expect(rest.more).toBe(false);
		const none = backlog.auditAfter(agent.db, "ws", rest.cursor, 10);
		expect(none).toEqual({ resync: false, cursor: rest.cursor, rows: [], more: false });
	});

	it("auditAfter answers resync when the row at the cursor was pruned", () => {
		add("ws", 1);
		const cursor = backlog.snapshot(agent.db, "ws").cursor;
		add("ws", 2);
		const newest = backlog.snapshot(agent.db, "ws").cursor;
		agent.transaction(() => {
			const rows = history.rowsBefore(agent.db, "backlog_audits", Number.MAX_SAFE_INTEGER, 100);
			history.deleteRows(
				agent.db,
				"backlog_audits",
				rows.filter((row) => Number(row.id) <= cursor),
			);
		});
		expect(backlog.auditAfter(agent.db, "ws", cursor, 10)).toEqual({ resync: true, cursor: newest });
		// A cursor of 0 was taken from an empty log: nothing was pruned after it.
		const fresh = backlog.auditAfter(agent.db, "ws", 0, 10);
		expect(fresh.resync).toBe(false);
	});
});
