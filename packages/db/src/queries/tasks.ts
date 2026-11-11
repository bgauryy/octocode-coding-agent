import type { DatabaseSync } from "node:sqlite";
import { allRows, num } from "../rows.ts";
import * as meta from "./meta.ts";

/** A persisted task with the number of the item that owns it (null for a session task). */
export interface TaskRow {
	id: number;
	workspace_id: string;
	seq: number;
	item_id: number | null;
	item_seq: number | null;
	session_id: string | null;
	goal: string;
	reason: string;
	result: string;
	state: string;
	position: number;
	assignee: string | null;
	created_at: number;
	updated_at: number;
	done_at: number | null;
	version: number;
}

/** Who owns a task: the row id of one item, or one session id; never both. */
export type TaskOwnerKey = { itemId: number } | { sessionId: string };

const SELECT = "SELECT t.*, b.seq AS item_seq FROM backlog_tasks t LEFT JOIN backlog b ON b.id = t.item_id";

/** Item tasks first (by item, then position), then session tasks (by session, then position). */
const ORDER = "t.item_id IS NULL, t.item_id, t.session_id, t.position, t.id";

const ownerArgs = (owner: TaskOwnerKey) => [
	"itemId" in owner ? owner.itemId : null,
	"sessionId" in owner ? owner.sessionId : null,
];

/** The `meta` key holding the repository's task number high-water mark. */
const markKey = (repo: string) => `backlog_task_seq:${repo}`;

/** The highest task number ever issued in the repository, or 0: the larger of the high-water mark and the newest row. */
function maxTaskSeq(db: DatabaseSync, repo: string): number {
	const row = db.prepare("SELECT MAX(seq) AS n FROM backlog_tasks WHERE workspace_id = ?").get(repo) as {
		n: number | null;
	};
	return Math.max(Number(meta.read(db, markKey(repo)) ?? 0), row.n ?? 0);
}

/** The next task number, recorded as the high-water mark so a number is never reused, even after its task is deleted. */
export function nextTaskSeq(db: DatabaseSync, repo: string): number {
	const seq = maxTaskSeq(db, repo) + 1;
	meta.write(db, markKey(repo), String(seq));
	return seq;
}

export function taskBySeq(db: DatabaseSync, repo: string, seq: number): TaskRow | undefined {
	return db.prepare(`${SELECT} WHERE t.workspace_id = ? AND t.seq = ?`).get(repo, seq) as TaskRow | undefined;
}

/** The stored fields of a new task; it goes last among its owner's tasks. */
export interface NewTask {
	repo: string;
	seq: number;
	owner: TaskOwnerKey;
	goal: string;
	reason: string;
	state: string;
	assignee: string | null;
	at: number;
}

/** Inserts a task at the end of its owner's list and returns it. */
export function insertTask(db: DatabaseSync, task: NewTask): TaskRow {
	const [itemId, sessionId] = ownerArgs(task.owner);
	db.prepare(
		`INSERT INTO backlog_tasks (workspace_id, seq, item_id, session_id, goal, reason, state, position, assignee, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position) + 1, 0) FROM backlog_tasks WHERE workspace_id = ? AND item_id IS ? AND session_id IS ?), ?, ?, ?)`,
	).run(
		task.repo,
		task.seq,
		itemId,
		sessionId,
		task.goal,
		task.reason,
		task.state,
		task.repo,
		itemId,
		sessionId,
		task.assignee,
		task.at,
		task.at,
	);
	return taskBySeq(db, task.repo, task.seq)!;
}

/** The fields an update rewrites; the version goes up by one. */
export interface TaskChanges {
	goal: string;
	reason: string;
	result: string;
	state: string;
	assignee: string | null;
	at: number;
	doneAt: number | null;
}

/** Rewrites a task and bumps its version; with `version`, only when the row still has it. Returns whether a row changed. */
export function updateTask(db: DatabaseSync, rowId: number, c: TaskChanges, version?: number): boolean {
	const { changes } = db
		.prepare(
			"UPDATE backlog_tasks SET goal = ?, reason = ?, result = ?, state = ?, assignee = ?, updated_at = ?, done_at = ?, version = version + 1 WHERE id = ? AND (? IS NULL OR version = ?)",
		)
		.run(c.goal, c.reason, c.result, c.state, c.assignee, c.at, c.doneAt, rowId, version ?? null, version ?? null);
	return Number(changes) > 0;
}

/** Which tasks a listing matches: one item's, one session's, or (neither named) the whole repository's. */
export interface TaskFilter {
	repo: string;
	itemId?: number;
	sessionId?: string;
	/** Only tasks in these states; unset is every state. */
	states?: readonly string[];
}

/** Matching tasks, each owner's in position order. */
export function listTasks(db: DatabaseSync, filter: TaskFilter): TaskRow[] {
	const where = ["t.workspace_id = ?"];
	const args: Array<string | number> = [filter.repo];
	if (filter.itemId !== undefined) {
		where.push("t.item_id = ?");
		args.push(filter.itemId);
	}
	if (filter.sessionId !== undefined) {
		where.push("t.session_id = ?");
		args.push(filter.sessionId);
	}
	if (filter.states?.length) {
		where.push(`t.state IN (${filter.states.map(() => "?").join(", ")})`);
		args.push(...filter.states);
	}
	return allRows<TaskRow>(db.prepare(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY ${ORDER}`), ...args);
}

/** How many tasks each owner has in each state, for the repository. */
export interface TaskCountRow {
	item_seq: number | null;
	session_id: string | null;
	state: string;
	n: number;
}

export function taskCounts(db: DatabaseSync, repo: string): TaskCountRow[] {
	return allRows<TaskCountRow>(
		db.prepare(
			"SELECT b.seq AS item_seq, t.session_id, t.state, COUNT(*) AS n FROM backlog_tasks t LEFT JOIN backlog b ON b.id = t.item_id WHERE t.workspace_id = ? GROUP BY t.item_id, t.session_id, t.state",
		),
		repo,
	).map((row) => ({ ...row, n: num(row.n) }));
}

/** Hands a task to another owner, last in its list, bumping its version. */
export function reparentTask(db: DatabaseSync, rowId: number, owner: TaskOwnerKey, at: number): void {
	const [itemId, sessionId] = ownerArgs(owner);
	db.prepare(
		`UPDATE backlog_tasks SET item_id = ?, session_id = ?, updated_at = ?, version = version + 1,
		 position = (SELECT COALESCE(MAX(position) + 1, 0) FROM backlog_tasks o WHERE o.workspace_id = backlog_tasks.workspace_id AND o.item_id IS ? AND o.session_id IS ?)
		 WHERE id = ?`,
	).run(itemId, sessionId, at, itemId, sessionId, rowId);
}

/**
 * Puts a task at `index` (0 first, clamped) among its owner's tasks and renumbers the others to match. Only the moved
 * task gets a new version and update time; the neighbours just shift.
 */
export function moveTask(db: DatabaseSync, rowId: number, index: number, at: number): void {
	const own = db.prepare("SELECT workspace_id, item_id, session_id FROM backlog_tasks WHERE id = ?").get(rowId) as
		| { workspace_id: string; item_id: number | null; session_id: string | null }
		| undefined;
	if (!own) return;
	const siblings = allRows<{ id: number; position: number }>(
		db.prepare(
			"SELECT id, position FROM backlog_tasks WHERE workspace_id = ? AND item_id IS ? AND session_id IS ? ORDER BY position, id",
		),
		own.workspace_id,
		own.item_id,
		own.session_id,
	);
	const order = siblings.filter((task) => task.id !== rowId);
	order.splice(Math.max(0, Math.min(order.length, Math.floor(index))), 0, { id: rowId, position: -1 });
	order.forEach((task, position) => {
		if (task.position === position) return;
		if (task.id === rowId)
			db.prepare("UPDATE backlog_tasks SET position = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(
				position,
				at,
				task.id,
			);
		else db.prepare("UPDATE backlog_tasks SET position = ? WHERE id = ?").run(position, task.id);
	});
}
