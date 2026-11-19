import type { DatabaseSync } from "node:sqlite";
import { allRows, type Row } from "../rows.ts";
import { WORKTREE_OPENINGS_SCHEMA } from "../schema-sql.ts";

/**
 * Who opened a worktree or a tmux window or pane: one row per thing (`kind`, `ref`), written when it is created. A
 * worktree's `ref` is its folder, a tmux one's is the id tmux printed (`%N` pane, `@N` window). The table is part of the
 * coordination schema (`schema-sql.ts`) and created at first use in a file made before it existed; a thing opened
 * before it was recorded simply has no row.
 */
export type OpeningKind = "worktree" | "tmux";

const ensured = new WeakSet<DatabaseSync>();

/** Creates the table in a file made before it existed. Once per connection; a no-op on a current file. */
export function ensure(db: DatabaseSync): void {
	if (ensured.has(db)) return;
	db.exec(WORKTREE_OPENINGS_SCHEMA);
	ensured.add(db);
}

export interface Opening {
	/** The agent id that opened it. */
	opener: string;
	/** The session the opener ran in, when known. */
	sessionId?: string;
	openedAt: number;
}

/** Records who opened `ref`, replacing an earlier row (a path or tmux id can be reused). */
export function record(
	db: DatabaseSync,
	kind: OpeningKind,
	ref: string,
	opener: string,
	sessionId: string | undefined,
	at: number,
): void {
	ensure(db);
	db.prepare(
		`INSERT INTO worktree_openings (kind, ref, opener, session_id, opened_at) VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(kind, ref) DO UPDATE SET opener = excluded.opener, session_id = excluded.session_id, opened_at = excluded.opened_at`,
	).run(kind, ref, opener, sessionId ?? null, at);
}

/** The openings recorded for `refs`, by ref; a ref with no row (opened before this was recorded) is absent. */
export function lookup(db: DatabaseSync, kind: OpeningKind, refs: readonly string[]): Map<string, Opening> {
	ensure(db);
	const found = new Map<string, Opening>();
	if (refs.length === 0) return found;
	const rows = allRows<Row>(
		db.prepare(
			`SELECT ref, opener, session_id, opened_at FROM worktree_openings WHERE kind = ? AND ref IN (SELECT value FROM json_each(?))`,
		),
		kind,
		JSON.stringify(refs),
	);
	for (const row of rows)
		found.set(String(row.ref), {
			opener: String(row.opener),
			...(typeof row.session_id === "string" ? { sessionId: row.session_id } : {}),
			openedAt: Number(row.opened_at),
		});
	return found;
}

/** Drops the row of a thing that no longer exists. */
export function forget(db: DatabaseSync, kind: OpeningKind, ref: string): void {
	ensure(db);
	db.prepare("DELETE FROM worktree_openings WHERE kind = ? AND ref = ?").run(kind, ref);
}

/** Empties the table (a purge of everything); returns the rows removed. The table has no workspace column. */
export function clear(db: DatabaseSync): number {
	ensure(db);
	return Number(db.prepare("DELETE FROM worktree_openings").run().changes);
}
