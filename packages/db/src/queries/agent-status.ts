import type { DatabaseSync } from "node:sqlite";
import { AGENT_STATUS_CHECK, AGENT_STATUS_CHECK_WITHOUT_SETTLED } from "../schema-sql.ts";
import { inTransaction } from "./transaction.ts";

const ensured = new WeakSet<DatabaseSync>();

type Entry = { sql: string };

/**
 * Lets `agents.status` hold `settled` in a schema10 file written before that status existed. SQLite cannot alter a CHECK in
 * place, so the table is rebuilt from its own stored definition (every other column and the mailbox column stay as they
 * are) and its indexes are created again. Nothing else references the table. Cache only after our own transaction committed.
 */
export function ensureSettledStatus(db: DatabaseSync): void {
	if (ensured.has(db)) return;
	const nested = db.isTransaction;
	const stored = () =>
		db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'agents'").get() as Entry | undefined;
	const old = (entry: Entry | undefined) =>
		entry !== undefined && entry.sql.includes(AGENT_STATUS_CHECK_WITHOUT_SETTLED);
	if (old(stored()))
		inTransaction(db, () => {
			const entry = stored();
			if (!old(entry)) return;
			const indexes = db
				.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'agents' AND sql IS NOT NULL")
				.all() as Entry[];
			const rebuilt = entry!.sql
				.replace(AGENT_STATUS_CHECK_WITHOUT_SETTLED, AGENT_STATUS_CHECK)
				.replace(/^CREATE TABLE\s+"?agents"?/i, "CREATE TABLE agents_rebuilt");
			db.exec(rebuilt);
			db.exec("INSERT INTO agents_rebuilt SELECT * FROM agents");
			db.exec("DROP TABLE agents");
			db.exec("ALTER TABLE agents_rebuilt RENAME TO agents");
			for (const index of indexes) db.exec(index.sql);
		});
	if (!nested) ensured.add(db);
}
