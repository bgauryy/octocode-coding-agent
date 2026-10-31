import type { DatabaseSync } from "node:sqlite";
import { allRows, num, type Row } from "../rows.ts";

/** A persisted item, including the joined sequence number of its origin. */
export interface ItemRow<State extends string> {
	id: number;
	seq: number;
	title: string;
	goal: string;
	body: string;
	paths: string;
	why: string;
	evidence: string;
	plan: string;
	state: State;
	priority: number;
	tags: string;
	assignee: string | null;
	created_by: string;
	source_session: string | null;
	created_at: number;
	updated_at: number;
	started_at: number | null;
	done_at: number | null;
	from_item: number | null;
	from_seq: number | null;
	version: number;
}

/** Items with the number of the item each came from; filters and order use the `b.` alias. */
const SELECT = "SELECT b.*, f.seq AS from_seq FROM backlog b LEFT JOIN backlog f ON f.id = b.from_item";

const ORDER = `CASE b.state WHEN 'ongoing' THEN 0 WHEN 'todo' THEN 1 WHEN 'backlog' THEN 2 ELSE 3 END, b.priority, b.updated_at DESC, b.seq DESC`;

const SEARCHED = ["title", "goal", "body", "paths", "why", "evidence", "plan"] as const;

const likeEscape = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

/** Which items a listing matches: `states` is never empty; `text` is a trimmed, non-empty search. */
export interface ItemFilter {
	repo: string;
	states: readonly string[];
	text?: string;
	/** Row id of the item the matches came from. */
	fromItem?: number;
}

/** The `WHERE` clause (aliased `b`) and its arguments for a filter. */
function whereOf(filter: ItemFilter): { clause: string; args: Array<string | number> } {
	const where = [`b.repo_key = ?`, `b.state IN (${filter.states.map(() => "?").join(", ")})`];
	const args: Array<string | number> = [filter.repo, ...filter.states];
	const text = filter.text;
	if (text) {
		// Every text field matches any substring (so `backlog/store` finds a path); a tag matches only whole (`ui` is not found in `build`), with or without `#`.
		where.push(
			`(${SEARCHED.map((column) => `b.${column} LIKE ? ESCAPE '\\'`).join(" OR ")} OR (' ' || b.tags || ' ') LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM backlog_completions c WHERE c.item = b.id AND c.payload LIKE ? ESCAPE '\\'))`,
		);
		const like = `%${likeEscape(text)}%`;
		args.push(...SEARCHED.map(() => like), `% ${likeEscape(text.replace(/^#+/, ""))} %`, like);
	}
	if (filter.fromItem !== undefined) {
		where.push("b.from_item = ?");
		args.push(filter.fromItem);
	}
	return { clause: where.join(" AND "), args };
}

/** One item row by its number in the repository. */
export function itemBySeq(db: DatabaseSync, repo: string, seq: number): ItemRow<string> | undefined {
	return db.prepare(`${SELECT} WHERE b.repo_key = ? AND b.seq = ?`).get(repo, seq) as ItemRow<string> | undefined;
}

/** The rows of the items that came from `rowId`, in board order. */
export function derivedFrom(db: DatabaseSync, rowId: number): ItemRow<string>[] {
	return allRows<ItemRow<string>>(db.prepare(`${SELECT} WHERE b.from_item = ? ORDER BY ${ORDER}`), rowId);
}

/** How many items a filter matches, ignoring any limit. */
export function countItems(db: DatabaseSync, filter: ItemFilter): number {
	const { clause, args } = whereOf(filter);
	return num((db.prepare(`SELECT COUNT(*) AS n FROM backlog b WHERE ${clause}`).get(...args) as { n: number }).n);
}

/** Matching rows, ongoing first, then by priority and most recently updated; a negative `limit` is every row. */
export function listItems(db: DatabaseSync, filter: ItemFilter, limit: number, offset: number): ItemRow<string>[] {
	const { clause, args } = whereOf(filter);
	return allRows<ItemRow<string>>(
		db.prepare(`${SELECT} WHERE ${clause} ORDER BY ${ORDER} LIMIT ? OFFSET ?`),
		...args,
		limit,
		offset,
	);
}

/** The item count of each state present in the repository. */
export function stateCounts(db: DatabaseSync, repo: string): Array<{ state: string; n: number }> {
	return db.prepare("SELECT state, COUNT(*) AS n FROM backlog WHERE repo_key = ? GROUP BY state").all(repo) as Array<{
		state: string;
		n: number;
	}>;
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

export function setType(db: DatabaseSync, rowId: number, type: string): void {
	db.prepare("UPDATE backlog SET type = ? WHERE id = ?").run(type, rowId);
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
}

export function insertItem(db: DatabaseSync, item: NewItem): void {
	db.prepare(
		`INSERT INTO backlog (repo_key, seq, title, goal, body, paths, why, evidence, plan, state, priority, tags, assignee, created_by, source_session, created_at, updated_at, started_at, done_at, from_item)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
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
	);
}

/** The fields an update rewrites; the version goes up by one. */
export interface ItemChanges {
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
		"UPDATE backlog SET title = ?, goal = ?, body = ?, paths = ?, why = ?, evidence = ?, plan = ?, state = ?, priority = ?, tags = ?, assignee = ?, updated_at = ?, started_at = ?, done_at = ?, from_item = ?, version = version + 1 WHERE id = ?",
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
