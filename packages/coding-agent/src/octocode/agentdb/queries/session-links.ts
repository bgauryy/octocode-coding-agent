import type { DatabaseSync } from "node:sqlite";
import { allRows, num } from "../rows.ts";

/** The most backlog items one session row shows. */
export const MAX_SESSION_ITEMS = 3;

/** What the database links to one session: the items it holds now and the team agent it runs as. */
export interface SessionLinks {
	/** Numbers (`seq`) of the `ongoing` items whose `assignee` is the session, most recently updated first. */
	items: number[];
	/** The name of the `agents` row whose `session_id` is the session; absent when none (a subagent's session id is its name, and rows leave with the process). */
	agent?: string;
}

const marks = (values: readonly unknown[]) => values.map(() => "?").join(", ");

/** The links of each of `ids` that has any, by session id. Never looks an agent up by name, only by `agents.session_id`. */
export function linksOf(db: DatabaseSync, ids: readonly string[]): Map<string, SessionLinks> {
	const links = new Map<string, SessionLinks>();
	if (ids.length === 0) return links;
	const of = (id: string) => links.get(id) ?? links.set(id, { items: [] }).get(id)!;
	const claims = allRows<{ assignee: string; seq: number }>(
		db.prepare(
			`SELECT assignee, seq FROM backlog WHERE state = 'ongoing' AND assignee IN (${marks(ids)}) ORDER BY updated_at DESC, seq DESC`,
		),
		...ids,
	);
	for (const { assignee, seq } of claims) {
		const held = of(assignee);
		if (held.items.length < MAX_SESSION_ITEMS) held.items.push(num(seq));
	}
	// The newest row wins when a session was joined twice (a name is dropped with its process, so rarely more than one).
	const named = allRows<{ session_id: string; id: string }>(
		db.prepare(`SELECT session_id, id FROM agents WHERE session_id IN (${marks(ids)}) ORDER BY seen_at, id`),
		...ids,
	);
	for (const { session_id, id } of named) of(session_id).agent = id;
	return links;
}

/**
 * Ids of the sessions that held or hold item `B<seq>`: its assignee in any state (a claim stays on `done`) and the
 * assignee of any of its steps. `repo` limits the item to one repository; without it every repository's `B<seq>` counts.
 */
export function heldItem(db: DatabaseSync, seq: number, repo?: string): string[] {
	// Two statements rather than `(? IS NULL OR repo_key = ?)`, which no index serves: with a repository the lookup uses
	// UNIQUE(repo_key, seq), without one the `backlog_seq` index.
	const items = `SELECT id, assignee FROM backlog WHERE seq = ?${repo === undefined ? "" : " AND repo_key = ?"}`;
	const args = repo === undefined ? [seq] : [seq, repo];
	const rows = allRows<{ id: string }>(
		db.prepare(
			`WITH b AS (${items})
			 SELECT assignee AS id FROM b WHERE assignee IS NOT NULL
			 UNION
			 SELECT t.assignee FROM backlog_tasks t JOIN b ON b.id = t.item_id WHERE t.assignee IS NOT NULL`,
		),
		...args,
	);
	return rows.map((row) => row.id);
}
