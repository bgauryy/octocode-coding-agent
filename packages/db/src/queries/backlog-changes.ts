import type { DatabaseSync } from "node:sqlite";
import { allRows, num } from "../rows.ts";

/** One open item as the task source sees it: enough to name it, rank it and write it back with its `version`. */
export interface SnapshotItem {
	seq: number;
	version: number;
	state: string;
	assignee: string | null;
	title: string;
	goal: string;
	priority: number;
	parent_seq: number | null;
}

/** The open items of a workspace and the newest audit id at the same instant: the cursor `auditAfter` continues from. */
export interface BacklogSnapshot {
	cursor: number;
	items: SnapshotItem[];
}

/**
 * Every open (not done or closed) item of workspace `repo`, most urgent first, with the workspace's newest audit id as
 * `cursor` (0 for an empty log). One statement, so the rows and the cursor come from one read.
 */
export function snapshot(db: DatabaseSync, repo: string): BacklogSnapshot {
	const rows = allRows<SnapshotItem & { cursor: number; seq: number | null }>(
		db.prepare(`
		SELECT c.cursor, b.seq, b.version, b.state, b.assignee, b.title, b.goal, b.priority, p.seq AS parent_seq
		FROM (SELECT COALESCE(MAX(id), 0) AS cursor FROM backlog_audits WHERE workspace_id = ?1) c
		LEFT JOIN backlog b ON b.workspace_id = ?1 AND b.state <> 'done'
		LEFT JOIN backlog p ON p.id = b.parent_id
		ORDER BY b.priority, b.seq
	`),
		repo,
	);
	return {
		cursor: num(rows[0]?.cursor ?? 0),
		items: rows
			.filter((row) => row.seq !== null)
			.map(({ cursor: _cursor, ...item }) => ({
				...item,
				seq: num(item.seq),
				version: num(item.version),
				priority: num(item.priority),
				parent_seq: item.parent_seq === null ? null : num(item.parent_seq),
			})),
	};
}

/**
 * One audit row after a cursor. For an item row (`entity` `backlog`) the item's fields after the change (and its state,
 * assignee, parent and paths before it); a link row names its `relation` and `target` (the stored JSON), a comment row its
 * `text`, a step row (`backlog_tasks` of an item) its state before and after in `step_state`/`before_step_state`; the other
 * fields are null. `actor` is the JSON the write recorded (`{id, kind?, surface?}`).
 */
export interface AuditAfterRow {
	id: number;
	backlog_id: string;
	action: string;
	entity: string;
	actor: string;
	version: number | null;
	state: string | null;
	assignee: string | null;
	before_assignee: string | null;
	title: string | null;
	/** 1 when the item is closed after the change. */
	closed: number;
	before_state: string | null;
	/** The parent epic's ref (`B7`) after and before the change. */
	parent_ref: string | null;
	before_parent_ref: string | null;
	/** The stored `paths` text (one path per line) after and before the change. */
	paths: string | null;
	before_paths: string | null;
	relation: string | null;
	target: string | null;
	text: string | null;
	step_state: string | null;
	before_step_state: string | null;
}

/**
 * A page of `auditAfter`: the rows and the cursor to continue from, or `resync` when rows after the cursor were pruned
 * (take a fresh `snapshot`; `cursor` is then the workspace's newest audit id).
 */
export type AuditPage =
	| { resync: false; cursor: number; rows: AuditAfterRow[]; more: boolean }
	| { resync: true; cursor: number };

/**
 * Workspace `repo`'s audit rows with an id above `afterId`, oldest first, at most `limit`. A cursor below the oldest
 * kept row (history housekeeping pruned the row it names) answers `resync`; a cursor of 0 is an empty log's and never does.
 */
export function auditAfter(db: DatabaseSync, repo: string, afterId: number, limit: number): AuditPage {
	const bounds = db
		.prepare("SELECT MIN(id) AS low, MAX(id) AS high FROM backlog_audits WHERE workspace_id = ?")
		.get(repo) as { low: number | null; high: number | null };
	const high = num(bounds.high ?? 0);
	if (afterId > 0 && (bounds.low === null ? afterId > high : afterId < num(bounds.low)))
		return { resync: true, cursor: high };
	const rows = allRows<AuditAfterRow>(
		db.prepare(`
		SELECT id, backlog_id, action, entity, actor,
			CASE WHEN entity = 'backlog' THEN after_value ->> '$.version' END AS version,
			CASE WHEN entity = 'backlog' THEN after_value ->> '$.state' END AS state,
			CASE WHEN entity = 'backlog' THEN after_value ->> '$.assignee' END AS assignee,
			CASE WHEN entity = 'backlog' THEN before_value ->> '$.assignee' END AS before_assignee,
			CASE WHEN entity = 'backlog' THEN after_value ->> '$.title' END AS title,
			CASE WHEN entity = 'backlog' AND after_value ->> '$.closed' IS NOT NULL THEN 1 ELSE 0 END AS closed,
			CASE WHEN entity = 'backlog' THEN before_value ->> '$.state' END AS before_state,
			CASE WHEN entity = 'backlog' THEN (SELECT 'B' || p.seq FROM backlog p WHERE p.id = after_value ->> '$.parent_id') END AS parent_ref,
			CASE WHEN entity = 'backlog' THEN (SELECT 'B' || p.seq FROM backlog p WHERE p.id = before_value ->> '$.parent_id') END AS before_parent_ref,
			CASE WHEN entity = 'backlog' THEN after_value ->> '$.paths' END AS paths,
			CASE WHEN entity = 'backlog' THEN before_value ->> '$.paths' END AS before_paths,
			CASE WHEN entity = 'backlog_links' THEN COALESCE(after_value, before_value) ->> '$.relation' END AS relation,
			CASE WHEN entity = 'backlog_links' THEN COALESCE(after_value, before_value) ->> '$.target' END AS target,
			CASE WHEN entity = 'backlog_comments' THEN after_value ->> '$.text' END AS text,
			CASE WHEN entity = 'backlog_tasks' THEN after_value ->> '$.state' END AS step_state,
			CASE WHEN entity = 'backlog_tasks' THEN before_value ->> '$.state' END AS before_step_state
		FROM backlog_audits WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT ?
	`),
		repo,
		afterId,
		limit + 1,
	).map((row) => ({
		...row,
		id: num(row.id),
		version: row.version === null ? null : num(row.version),
		closed: num(row.closed),
	}));
	const more = rows.length > limit;
	const page = more ? rows.slice(0, limit) : rows;
	return { resync: false, cursor: page.at(-1)?.id ?? afterId, rows: page, more };
}

/** A session waiting for items (an active `wait` on `item`): the refs it names. */
export interface ItemWatcher {
	session: string;
	refs: string[];
}

/**
 * The sessions of workspace `repo` whose active `item` waits name any of `refs`, with every ref each names. A condition
 * that does not decode (a kind this version does not know) names nothing. When a state is supplied, sessions with
 * a matching state timer already get its notification and need no additional peer wake.
 */
export function itemWatchers(
	db: DatabaseSync,
	repo: string,
	refs: readonly string[],
	notifiedState?: string,
): ItemWatcher[] {
	const wanted = new Set(refs);
	const named = new Map<string, Set<string>>();
	const notified = new Set<string>();
	const rows = allRows<{ session_id: string; condition: string }>(
		db.prepare(
			"SELECT session_id, condition FROM timers WHERE workspace_id = ? AND status = 'active' AND condition_kind = 'item'",
		),
		repo,
	);
	for (const row of rows) {
		const { ref, state } = JSON.parse(row.condition) as { ref?: unknown; state?: unknown };
		if (typeof ref !== "string") continue;
		const mine = ref.split(/[\s,]+/).filter(Boolean);
		if (!mine.some((each) => wanted.has(each))) continue;
		if (notifiedState !== undefined && state === notifiedState) notified.add(row.session_id);
		const set = named.get(row.session_id) ?? new Set<string>();
		for (const each of mine) set.add(each);
		named.set(row.session_id, set);
	}
	for (const session of notified) named.delete(session);
	return [...named].map(([session, set]) => ({ session, refs: [...set] }));
}
