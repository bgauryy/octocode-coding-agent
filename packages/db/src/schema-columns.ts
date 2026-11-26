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

/**
 * `workspaces.db_key` (machine file): the key of the workspace file holding this workspace's rows (`schema-split.ts`).
 * Set once, at the first registration or by the version-12 split, and never changed: every workspace of one repository
 * shares one key. NULL until then.
 */
export const WORKSPACE_DB_KEY_COLUMN = "db_key TEXT";

/** Columns added to a table of the version-10 file after it shipped: `SCHEMA` creates them, its upgrade adds them. */
const ADDED_COLUMNS: ReadonlyArray<{ table: string; column: string; definition: string }> = [
	{ table: "sessions", column: "activity", definition: SESSION_ACTIVITY_COLUMN },
	{ table: "sessions", column: "activity_by", definition: SESSION_ACTIVITY_BY_COLUMN },
];

/**
 * Gives a version-10 file the columns it lacks, inside its upgrade transaction: an `ALTER TABLE … ADD COLUMN` (nullable,
 * so existing rows need no rewrite) for each column the catalog does not list yet.
 */
export function addMissingColumns(db: DatabaseSync): void {
	for (const { table, column, definition } of ADDED_COLUMNS) addColumn(db, table, column, definition);
}

/** `ALTER TABLE … ADD COLUMN` unless the table already has `column`. */
export function addColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
	if (db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}
