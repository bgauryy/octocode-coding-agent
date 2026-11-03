import type { DatabaseSync } from "node:sqlite";

/**
 * Runs `work` as one write transaction on `db`: it joins the transaction the caller already holds (`AgentDb.transaction`),
 * else it opens a BEGIN IMMEDIATE one and commits or rolls back. Query modules use it for operations that must not
 * stop half way (forget, purge); it does not notify `AgentDb.onCommit` listeners, which only the backlog uses.
 */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
	if (db.isTransaction) return work();
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = work();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			/* SQLite may already have rolled back. */
		}
		throw error;
	}
}
