import type { DatabaseSync } from "node:sqlite";
import * as meta from "./queries/meta.ts";

/** A table a new file takes over from the retired one, and the carried tables its rows refer to. */
export interface CarriedTable {
	name: string;
	needs?: readonly string[];
}

/**
 * The coordination file's tables people wrote themselves, parents before the tables that refer to them: notes, the
 * backlog with its tasks, notes, comments and history, folder trust and review decisions, and `!` command history.
 * Everything else (agents, runs, mail, leases, the session catalog) describes processes that are gone or is rebuilt
 * from the session files.
 */
export const COORDINATION_CARRIED: readonly CarriedTable[] = [
	{ name: "workspaces" },
	{ name: "memories", needs: ["workspaces"] },
	{ name: "backlog", needs: ["workspaces"] },
	{ name: "backlog_links", needs: ["backlog"] },
	{ name: "backlog_completions", needs: ["backlog"] },
	{ name: "backlog_notes", needs: ["backlog"] },
	{ name: "backlog_comments", needs: ["backlog", "backlog_notes"] },
	{ name: "backlog_tasks", needs: ["workspaces", "backlog"] },
	{ name: "backlog_audits", needs: ["workspaces"] },
	{ name: "trusted_folders" },
	{ name: "item_reviews" },
	{ name: "shell_history" },
];

/** The `meta` key of the carry record: the retired file, its version, rows carried and tables left there, by name. */
export const CARRY_META_KEY = "carried_from_retired";

export interface CarryRecord {
	file: string;
	version: number;
	carried: Record<string, number>;
	/** Tables left in the retired file, with the reason. */
	left: Record<string, string>;
}

/** The new file's open connection: its handle, its transaction, and its close for a failed carry. */
interface NewFile {
	db: DatabaseSync;
	transaction<T>(fn: () => T): T;
	close(): void;
}

/**
 * Copies `tables` from the `retired` file (set aside at schema `version`) into the new file, in one transaction, and
 * records what it did under `CARRY_META_KEY`. A table is copied row for row when the new schema has
 * every column the old one has and the old one has every column the new one requires; otherwise it is left in the
 * retired file, and so are the tables that need it. The new file's triggers on those tables are held while the rows
 * go in, so they arrive as they were (no audit rows, notes not doubled into comments), and the memory index is rebuilt.
 * A row the new schema's checks refuse leaves its table behind too. Nothing in the retired file changes. Any other
 * failure closes the new file, still empty, and throws.
 */
export function carryRetired(
	file: NewFile,
	retired: string,
	version: number,
	tables: readonly CarriedTable[],
): CarryRecord {
	const { db } = file;
	try {
		db.prepare("ATTACH DATABASE ? AS retired").run(retired);
		try {
			return file.transaction(() => carry(db, retired, version, tables));
		} finally {
			db.exec("DETACH DATABASE retired");
		}
	} catch (error) {
		file.close();
		throw new Error(`Carrying user data from ${retired} into the new database failed; it is all still there.`, {
			cause: error,
		});
	}
}

/** The carry inside the new file's transaction, with the retired file attached as `retired`. */
function carry(db: DatabaseSync, retired: string, version: number, tables: readonly CarriedTable[]): CarryRecord {
	const record: CarryRecord = { file: retired, version, carried: {}, left: {} };
	const held = heldTriggers(db, tables);
	for (const { name } of held) db.exec(`DROP TRIGGER main."${name}"`);
	for (const table of tables) {
		const missing = table.needs?.find((parent) => record.carried[parent] === undefined);
		const reason = missing ? `needs ${missing}, which was not carried` : copyTable(db, table.name, record);
		if (reason) record.left[table.name] = reason;
	}
	for (const { sql } of held) db.exec(sql);
	if (hasTable(db, "main", "memories_fts")) db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
	meta.write(db, CARRY_META_KEY, JSON.stringify(record));
	return record;
}

/** The new file's triggers on `tables`, with the SQL that creates each again. */
function heldTriggers(db: DatabaseSync, tables: readonly CarriedTable[]): Array<{ name: string; sql: string }> {
	return db
		.prepare(
			"SELECT name, sql FROM main.sqlite_schema WHERE type = 'trigger' AND tbl_name IN (SELECT value FROM json_each(?))",
		)
		.all(JSON.stringify(tables.map((table) => table.name))) as Array<{ name: string; sql: string }>;
}

function hasTable(db: DatabaseSync, schema: "main" | "retired", table: string): boolean {
	return db.prepare(`SELECT 1 FROM ${schema}.sqlite_schema WHERE type = 'table' AND name = ?`).get(table) !== undefined;
}

interface Column {
	name: string;
	required: number;
}

function columns(db: DatabaseSync, schema: "main" | "retired", table: string): Column[] {
	return db
		.prepare(
			"SELECT name, (\"notnull\" = 1 AND dflt_value IS NULL AND NOT (pk = 1 AND type = 'INTEGER')) AS required FROM pragma_table_info(?, ?)",
		)
		.all(table, schema) as unknown as Column[];
}

/** SQLITE_CONSTRAINT, whatever its extended code: a check, unique or foreign key the new schema holds. */
const isConstraint = (error: unknown) => (((error as { errcode?: number } | null)?.errcode ?? 0) & 0xff) === 19;

/** Copies one table into the new file and counts it in `record`; the reason it stays in the retired file otherwise. */
function copyTable(db: DatabaseSync, table: string, record: CarryRecord): string | undefined {
	if (!hasTable(db, "retired", table)) return "not in the retired file";
	const old = columns(db, "retired", table);
	const now = columns(db, "main", table);
	const dropped = old.filter((column) => !now.some((each) => each.name === column.name));
	if (dropped.length > 0) return `the new schema has no ${dropped.map((column) => column.name).join(", ")}`;
	const unset = now.filter((column) => column.required && !old.some((each) => each.name === column.name));
	if (unset.length > 0) return `the retired file has no ${unset.map((column) => column.name).join(", ")}`;
	const list = old.map((column) => `"${column.name}"`).join(", ");
	db.exec("SAVEPOINT carry_table");
	try {
		const copied = db.prepare(`INSERT INTO main."${table}" (${list}) SELECT ${list} FROM retired."${table}"`).run();
		db.exec("RELEASE carry_table");
		record.carried[table] = Number(copied.changes);
		return undefined;
	} catch (error) {
		db.exec("ROLLBACK TO carry_table");
		db.exec("RELEASE carry_table");
		if (!isConstraint(error)) throw error;
		return `a row breaks the new schema (${error instanceof Error ? error.message : String(error)})`;
	}
}
