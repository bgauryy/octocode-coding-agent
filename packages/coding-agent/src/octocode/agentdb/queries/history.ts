import type { DatabaseSync } from "node:sqlite";
import { num, type Row } from "../rows.ts";

/**
 * The history tables housekeeping moves out of the database by age (`backlog/retention.ts`): audit rows and web
 * receipts. Each audit table keeps a trigger that refuses DELETE; `deleteRows` lifts it only inside its own write
 * transaction. Backlog items, notes and comments are never pruned here.
 */
const TABLES = {
	backlog_audits: { guard: "backlog_audits_immutable_delete" },
	config_audits: { guard: "config_audits_immutable_delete" },
	workspace_commands: { guard: undefined },
} as const;
export type HistoryTable = keyof typeof TABLES;

/**
 * When the oldest row of `table` was written, or undefined when it is empty. A scan, not a lookup of the lowest id: a
 * clock set back writes older times under higher ids. Housekeeping keeps the tables to about two weeks of rows.
 */
export function oldestAt(db: DatabaseSync, table: HistoryTable): number | undefined {
	const row = db.prepare(`SELECT MIN(at) AS at FROM ${table}`).get() as Row | undefined;
	return typeof row?.at === "number" ? row.at : undefined;
}

/** Up to `limit` rows of `table` written before `before`, oldest first, every column as stored. */
export function rowsBefore(db: DatabaseSync, table: HistoryTable, before: number, limit: number): Row[] {
	return db
		.prepare(
			table === "workspace_commands"
				? "SELECT * FROM workspace_commands WHERE at < ? ORDER BY at, rowid LIMIT ?"
				: `SELECT * FROM ${table} WHERE at < ? ORDER BY id LIMIT ?`,
		)
		.all(before, limit);
}

/**
 * Deletes exactly `rows` (as `rowsBefore` returned them) and returns how many went. Run it inside one write
 * transaction (`AgentDb.transaction`): the table's DELETE guard is dropped and re-created from its stored text in that
 * same transaction, so no other connection, of this build or an older one, ever sees the table unguarded, and the
 * guard comes back exactly as it was.
 */
export function deleteRows(db: DatabaseSync, table: HistoryTable, rows: readonly Row[]): number {
	if (rows.length === 0) return 0;
	if (!db.isTransaction) throw new Error(`Deleting ${table} rows needs a write transaction.`);
	const { guard } = TABLES[table];
	const stored = guard
		? (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(guard) as Row | undefined)
		: undefined;
	if (stored) db.exec(`DROP TRIGGER ${guard}`);
	const deleted =
		table === "workspace_commands"
			? db
					.prepare(
						"DELETE FROM workspace_commands WHERE (repo_key, session_id, id) IN (SELECT value ->> 0, value ->> 1, value ->> 2 FROM json_each(?))",
					)
					.run(JSON.stringify(rows.map((row) => [row.repo_key, row.session_id, row.id])))
			: db
					.prepare(`DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`)
					.run(JSON.stringify(rows.map((row) => row.id)));
	if (stored) db.exec(String(stored.sql));
	return Number(deleted.changes);
}

/** Runs `work` with this connection waiting at most `ms` for another process's lock, then restores its wait. */
export function withBusyTimeout<T>(db: DatabaseSync, ms: number, work: () => T): T {
	const previous = num((db.prepare("PRAGMA busy_timeout").get() as Row | undefined)?.timeout);
	db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(ms))}`);
	try {
		return work();
	} finally {
		db.exec(`PRAGMA busy_timeout=${previous}`);
	}
}

/** SQLite's "database is locked" (`SQLITE_BUSY`, extended codes included). */
export const isBusy = (error: unknown): boolean => (Number((error as { errcode?: unknown }).errcode) & 0xff) === 5;
