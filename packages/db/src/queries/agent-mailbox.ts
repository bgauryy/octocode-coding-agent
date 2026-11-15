import type { DatabaseSync } from "node:sqlite";
import { AGENT_MAILBOX_COLUMN } from "../schema-sql.ts";
import { inTransaction } from "./transaction.ts";

const ensured = new WeakSet<DatabaseSync>();

/** Add the optional capability without retiring schema10 data. Cache only after our own transaction committed. */
export function ensureMailbox(db: DatabaseSync): void {
	if (ensured.has(db)) return;
	const nested = db.isTransaction;
	const present = db.prepare("SELECT 1 FROM pragma_table_info('agents') WHERE name = 'mailbox'");
	if (!present.get())
		inTransaction(db, () => {
			if (!present.get()) db.exec(`ALTER TABLE agents ADD COLUMN ${AGENT_MAILBOX_COLUMN}`);
		});
	if (!nested) ensured.add(db);
}
