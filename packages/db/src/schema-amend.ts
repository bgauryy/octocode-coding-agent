import type { DatabaseSync } from "node:sqlite";
import { JOBS_SCHEMA } from "./schema-jobs.ts";

/**
 * Additions made to the coordination schema since version 10, applied in place to a file that lacks them: a new table
 * and a nullable column, which an Octocode that predates them never reads, so both versions share one file while they
 * run side by side and nothing is set aside. Only additions of that kind belong here; any other change needs a version
 * bump (`schema.ts`).
 */
export function coordinationGaps(db: DatabaseSync): boolean {
	const row = db
		.prepare(`
		SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='jobs') AS jobs,
			EXISTS(SELECT 1 FROM pragma_table_info('leases') WHERE name='item') AS lease_item`)
		.get() as { jobs: number; lease_item: number };
	return !row.jobs || !row.lease_item;
}

/** Adds what `coordinationGaps` found missing; run in a write transaction, so a second opener finds nothing left to add. */
export function amendCoordination(db: DatabaseSync): void {
	if (!coordinationGaps(db)) return;
	db.exec(JOBS_SCHEMA);
	const leaseItem = db.prepare("SELECT 1 AS found FROM pragma_table_info('leases') WHERE name='item'").get();
	if (!leaseItem) db.exec("ALTER TABLE leases ADD COLUMN item TEXT");
}
