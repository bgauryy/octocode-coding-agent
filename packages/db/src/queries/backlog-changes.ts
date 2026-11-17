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
 * One audit row after a cursor. For an item row (`entity` `backlog`) the item's fields after the change (and its
 * assignee before it); null for link and step rows. `actor` is the JSON the write recorded (`{id, kind?, surface?}`).
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
			CASE WHEN entity = 'backlog' AND after_value ->> '$.closed' IS NOT NULL THEN 1 ELSE 0 END AS closed
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
