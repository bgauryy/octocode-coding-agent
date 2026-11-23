import type { DatabaseSync } from "node:sqlite";

/**
 * `sessions.activity` (`queries/sessions.ts` `setActivity`): the last light tone of a live session (the contracts'
 * `ACTIVITY_TONES`), written by the process that has it open when the tone changes, `idle` at its start and cleared at
 * its end. NULL: no light known (the session is not open, or an older Octocode has it open). Readers trust it only
 * while the row's pid is alive.
 */
export const SESSION_ACTIVITY_COLUMN =
	"activity TEXT CHECK(activity IS NULL OR activity IN ('working','waiting','error','idle'))";

/**
 * `sessions.activity_by`: the process that wrote `activity`, as `<pid>:<start time>` (empty when unknown). A reader
 * trusts the light only while it names the row's current process: an older Octocode's start takes the row without
 * clearing the light a crashed process left, and a reused pid has another start time.
 */
export const SESSION_ACTIVITY_BY_COLUMN = "activity_by TEXT";

/** Columns added to a table of the version-10 file after it shipped: `SCHEMA` creates them, `ensureAddedColumns` adds them. */
const ADDED_COLUMNS: ReadonlyArray<{ table: string; column: string; definition: string }> = [
	{ table: "sessions", column: "activity", definition: SESSION_ACTIVITY_COLUMN },
	{ table: "sessions", column: "activity_by", definition: SESSION_ACTIVITY_BY_COLUMN },
];

/**
 * Gives a current file the columns it lacks, like the ensured objects: one catalog read per column on every open, an
 * `ALTER TABLE … ADD COLUMN` once per file (nullable, so existing rows need no rewrite). Another process may add the same
 * column between the read and the change: its "duplicate column" is the outcome wanted, anything else throws.
 */
export function ensureAddedColumns(db: DatabaseSync): void {
	for (const { table, column, definition } of ADDED_COLUMNS) {
		if (db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column)) continue;
		try {
			db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
		} catch (error) {
			if (!(error instanceof Error && /duplicate column name/i.test(error.message))) throw error;
		}
	}
}
