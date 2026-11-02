import type { DatabaseSync } from "node:sqlite";
import { allRows, num, type Row } from "../rows.ts";

// Item rows and listings (one item, an origin's derived items, filtered pages) live beside this module.
export * from "./backlog-items.ts";

/** Every item's row id, type, state and parent's row id: the least the counts need (an epic's state comes from its children). */
export function countHeads(
	db: DatabaseSync,
	repo: string,
): Array<{ id: number; type: string; state: string; parent_id: number | null }> {
	return allRows<{ id: number; type: string; state: string; parent_id: number | null }>(
		db.prepare("SELECT id, type, state, parent_id FROM backlog WHERE repo_key = ?"),
		repo,
	);
}

/** The newest `limit` notes after skipping `offset` of them, newest first. */
export function notesPage(
	db: DatabaseSync,
	rowId: number,
	limit: number,
	offset: number,
): Array<{ at: number; author: string; kind: string; text: string }> {
	return allRows<{ at: number; author: string; kind: string; text: string }>(
		db.prepare(
			"SELECT at, author, kind, text FROM backlog_notes WHERE item = ? ORDER BY at DESC, id DESC LIMIT ? OFFSET ?",
		),
		rowId,
		limit,
		offset,
	);
}

export function noteCount(db: DatabaseSync, rowId: number): number {
	return num((db.prepare("SELECT COUNT(*) AS n FROM backlog_notes WHERE item = ?").get(rowId) as { n: number }).n);
}

/** An item's comments, oldest first. */
export function commentsOf(
	db: DatabaseSync,
	rowId: number,
): Array<{ id: number; at: number; author: string; text: string }> {
	return allRows<{ id: number; at: number; author: string; text: string }>(
		db.prepare("SELECT id, at, author, text FROM backlog_comments WHERE item = ? ORDER BY id"),
		rowId,
	);
}

/** The newest audit rows first, `limit` of them; `ref` narrows to one item, `before` to ids below it. */
export function auditRows(
	db: DatabaseSync,
	repo: string,
	ref: string | undefined,
	before: number | undefined,
	limit: number,
): Array<Record<string, string | number | null>> {
	return db
		.prepare(
			"SELECT * FROM backlog_audits WHERE repo_key = ? AND (? IS NULL OR backlog_id = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?",
		)
		.all(repo, ref ?? null, ref ?? null, before ?? null, before ?? null, limit) as Array<
		Record<string, string | number | null>
	>;
}

/** An item's type, parent number and JSON-encoded links and completions, as `entityRows` returns them. */
export interface EntityRow {
	id: number;
	type: string;
	parent_seq: number | null;
	links: string;
	completions: string;
}

/** The entity data of several items in one statement, each relation in its stored order. */
export function entityRows(db: DatabaseSync, repo: string, rowIds: readonly number[]): EntityRow[] {
	return allRows<EntityRow>(
		db.prepare(`
		SELECT b.id, b.type, p.seq AS parent_seq,
			(SELECT json_group_array(json_object('relation', relation, 'target', target)) FROM
				(SELECT relation, target FROM backlog_links WHERE item = b.id ORDER BY rowid)) AS links,
			(SELECT json_group_array(json_object('id', id, 'payload', payload)) FROM
				(SELECT id, payload FROM backlog_completions WHERE item = b.id ORDER BY id)) AS completions
		FROM backlog b LEFT JOIN backlog p ON p.id = b.parent_id AND p.repo_key = ?
		WHERE b.id IN (SELECT value FROM json_each(?))
	`),
		repo,
		JSON.stringify(rowIds),
	);
}

export function setParent(db: DatabaseSync, rowId: number, parentRowId: number | null): void {
	db.prepare("UPDATE backlog SET parent_id = ? WHERE id = ?").run(parentRowId, rowId);
}

/** A parent (`parent`, its row id or null for none) and type to write; an absent one keeps the stored value. */
export interface EntityColumns {
	parent?: { rowId: number | null };
	type?: string;
}

/** Writes a new item's parent and type in one statement (an update writes them with `saveItem`). */
export function setEntityColumns(db: DatabaseSync, rowId: number, c: EntityColumns): void {
	db.prepare(
		"UPDATE backlog SET parent_id = CASE WHEN ? THEN ? ELSE parent_id END, type = COALESCE(?, type) WHERE id = ?",
	).run(c.parent ? 1 : 0, c.parent?.rowId ?? null, c.type ?? null, rowId);
}

/** The states of the items whose parent is the item `rowId` (an epic's children), in no particular order. */
export function childStates(db: DatabaseSync, rowId: number): string[] {
	return allRows<{ state: string }>(db.prepare("SELECT state FROM backlog WHERE parent_id = ?"), rowId).map(
		(row) => row.state,
	);
}

/** Drops an item's dependency links (`dependsOn`) or all its other links. */
export function clearLinks(db: DatabaseSync, rowId: number, dependsOn: boolean): void {
	db.prepare(`DELETE FROM backlog_links WHERE item = ? AND relation ${dependsOn ? "=" : "!="} 'depends_on'`).run(rowId);
}

/** Adds a link of `relation` with its JSON `target`; an existing identical link stays as it is. */
export function addLink(db: DatabaseSync, rowId: number, relation: string, target: string): void {
	db.prepare("INSERT OR IGNORE INTO backlog_links VALUES (?, ?, ?)").run(rowId, relation, target);
}

export function addCompletion(db: DatabaseSync, rowId: number, operationKey: string, payload: string): void {
	db.prepare("INSERT INTO backlog_completions (item, operation_key, payload) VALUES (?, ?, ?)").run(
		rowId,
		operationKey,
		payload,
	);
}

export function addNote(db: DatabaseSync, rowId: number, at: number, author: string, kind: string, text: string): void {
	db.prepare("INSERT INTO backlog_notes (item, at, author, kind, text) VALUES (?, ?, ?, ?, ?)").run(
		rowId,
		at,
		author,
		kind,
		text,
	);
}

/** The highest item number in the repository, or 0 when it has none. */
export function maxSeq(db: DatabaseSync, repo: string): number {
	const row = db.prepare("SELECT MAX(seq) AS n FROM backlog WHERE repo_key = ?").get(repo) as { n: number | null };
	return row.n ?? 0;
}

/** The stored fields of a new item; it starts unassigned and unstarted. */
export interface NewItem {
	repo: string;
	seq: number;
	title: string;
	goal: string;
	body: string;
	paths: string;
	why: string;
	evidence: string;
	plan: string;
	state: string;
	priority: number;
	tags: string;
	createdBy: string;
	sourceSession: string | null;
	at: number;
	fromItem: number | null;
	/** The item type; a database made before the rename defaults the column to `task`, so it is always written. */
	type: string;
}

export function insertItem(db: DatabaseSync, item: NewItem): void {
	db.prepare(
		`INSERT INTO backlog (repo_key, seq, title, goal, body, paths, why, evidence, plan, state, priority, tags, assignee, created_by, source_session, created_at, updated_at, started_at, done_at, from_item, type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		item.repo,
		item.seq,
		item.title,
		item.goal,
		item.body,
		item.paths,
		item.why,
		item.evidence,
		item.plan,
		item.state,
		item.priority,
		item.tags,
		item.createdBy,
		item.sourceSession,
		item.at,
		item.at,
		null,
		null,
		item.fromItem,
		item.type,
	);
}

/** The fields an update rewrites (parent and type only when given); the version goes up by one. */
export interface ItemChanges extends EntityColumns {
	title: string;
	goal: string;
	body: string;
	paths: string;
	why: string;
	evidence: string;
	plan: string;
	state: string;
	priority: number;
	tags: string;
	assignee: string | null;
	at: number;
	startedAt: number | null;
	doneAt: number | null;
	fromItem: number | null;
}

export function saveItem(db: DatabaseSync, rowId: number, c: ItemChanges): void {
	db.prepare(
		"UPDATE backlog SET title = ?, goal = ?, body = ?, paths = ?, why = ?, evidence = ?, plan = ?, state = ?, priority = ?, tags = ?, assignee = ?, updated_at = ?, started_at = ?, done_at = ?, from_item = ?, parent_id = CASE WHEN ? THEN ? ELSE parent_id END, type = COALESCE(?, type), version = version + 1 WHERE id = ?",
	).run(
		c.title,
		c.goal,
		c.body,
		c.paths,
		c.why,
		c.evidence,
		c.plan,
		c.state,
		c.priority,
		c.tags,
		c.assignee,
		c.at,
		c.startedAt,
		c.doneAt,
		c.fromItem,
		c.parent ? 1 : 0,
		c.parent?.rowId ?? null,
		c.type ?? null,
		rowId,
	);
}

/** Clears an item's origin link at `at`, bumping its version. */
export function clearOrigin(db: DatabaseSync, rowId: number, at: number): void {
	db.prepare("UPDATE backlog SET from_item = NULL, updated_at = ?, version = version + 1 WHERE id = ?").run(at, rowId);
}

export function deleteItem(db: DatabaseSync, rowId: number): void {
	db.prepare("DELETE FROM backlog WHERE id = ?").run(rowId);
}

/** Ongoing backlog items assigned to session `sessionId` in `repoKey` (most important first), for the resume brief. */
export function ongoingItems(
	db: DatabaseSync,
	repoKey: string,
	sessionId: string,
): Array<{ seq: number; title: string; goal: string; paths: string }> {
	return db
		.prepare(
			"SELECT seq, title, goal, paths FROM backlog WHERE repo_key = ? AND state = 'ongoing' AND assignee = ? ORDER BY priority, updated_at DESC",
		)
		.all(repoKey, sessionId) as Array<{ seq: number; title: string; goal: string; paths: string }>;
}

/** Backlog items of `repoKey` still to do. */
export function todoCount(db: DatabaseSync, repoKey: string): number {
	return num(
		(db.prepare("SELECT COUNT(*) AS n FROM backlog WHERE repo_key = ? AND state = 'todo'").get(repoKey) as Row).n,
	);
}

/** Every repository key that has backlog items. */
export function repoKeys(db: DatabaseSync): string[] {
	return (db.prepare("SELECT DISTINCT repo_key FROM backlog").all() as Array<{ repo_key: string }>).map(
		(row) => row.repo_key,
	);
}

/** Whether a note of kind `note` has no comment copied from it yet (an older build wrote it). */
export function hasUncopiedNotes(db: DatabaseSync): boolean {
	return (
		db
			.prepare(
				"SELECT 1 FROM backlog_notes n WHERE kind = 'note' AND NOT EXISTS (SELECT 1 FROM backlog_comments c WHERE c.legacy_note_id = n.id) LIMIT 1",
			)
			.get() !== undefined
	);
}

/** Copies every note of kind `note` that has no comment yet into `backlog_comments`. */
export function copyNotesToComments(db: DatabaseSync): void {
	db.exec(`INSERT OR IGNORE INTO backlog_comments(item, legacy_note_id, at, author, text)
 SELECT item, id, at, author, text FROM backlog_notes WHERE kind = 'note'`);
}
