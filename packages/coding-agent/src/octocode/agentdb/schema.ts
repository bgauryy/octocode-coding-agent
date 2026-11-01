import type { DatabaseSync } from "node:sqlite";
import { allRows, num, type Row } from "./rows.ts";
import { FTS, FTS_OBJECTS, SCHEMA } from "./schema-sql.ts";

/**
 * The agent database's schema: durable sessions, backlog and memories, and the team's transient state (presence,
 * messages kept a day, leases, recent edits). There is one schema and no version number: opening a database of ours
 * adds what `SCHEMA` has and the file lacks (tables, columns, indexes, triggers), and never removes anything. Builds
 * of different ages share one file (every running Octocode opens it), so an older build must not drop a newer build's
 * columns or tables, nor a newer one rebuild an older one's: schema changes are additive (a new table, a column with
 * a default, an index). The only rewrites of existing rows are the data migrations `openAgentDb` runs after
 * this reconcile (`queries/backlog.ts`: notes copied to comments once, item type `task` renamed `feature` on every open that
 * finds one); none of them
 * changes a table's shape, so `backlog.type` still has no CHECK constraint (an older build may write `task` again,
 * which the next open rewrites and every read maps to `feature`). Behavior an existing trigger cannot get (the reconcile
 * compares names only) comes from a new trigger beside it: `backlog_audits_skip_noop` drops an `update` audit row whose
 * before and after differ only in time, version or the legacy `task` type, whichever build wrote it. A file that is not
 * ours is refused and never touched.
 */

/** The file is not an agent database this code may use (another app's file, or not SQLite). Not retried. */
export class AgentDbError extends Error {}

/** Marks the file as an Octocode for Octocode agent database ("OcPg"); a file with another id is never touched. */
export const AGENT_APPLICATION_ID = 0x4f635067;

const pragma = (db: DatabaseSync, name: string) => num((db.prepare(`PRAGMA ${name}`).get() as Row | undefined)?.[name]);

interface SchemaObject {
	type: "table" | "index" | "trigger";
	name: string;
	tbl_name: string;
	sql: string;
}

const objects = (db: DatabaseSync): SchemaObject[] =>
	allRows<SchemaObject>(
		db.prepare(
			"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') AND sql IS NOT NULL AND substr(name, 1, 7) <> 'sqlite_'",
		),
	).filter((object) => !FTS_OBJECTS.test(object.name));
interface Column {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
}
const columns = (db: DatabaseSync, table: string): Column[] =>
	allRows<Column>(db.prepare(`PRAGMA table_info(${quote(table)})`));
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** `SCHEMA` as SQLite stores it, read from a scratch in-memory database. */
function reference(db: DatabaseSync): { objects: SchemaObject[]; columns: Map<string, Column[]> } {
	const Database = db.constructor as new (file: string) => DatabaseSync;
	const scratch = new Database(":memory:");
	try {
		scratch.exec(SCHEMA);
		const all = objects(scratch);
		return {
			objects: all,
			columns: new Map(
				all.filter((object) => object.type === "table").map((table) => [table.name, columns(scratch, table.name)]),
			),
		};
	} finally {
		scratch.close();
	}
}

/** The SQL that adds what `SCHEMA` has and `db` lacks, in order (tables, then columns, then indexes and triggers). */
function missing(db: DatabaseSync): string[] {
	const want = reference(db);
	const have = new Map(objects(db).map((object) => [object.name, object]));
	const steps: string[] = [];
	for (const table of want.objects.filter((object) => object.type === "table")) {
		if (!have.has(table.name)) {
			steps.push(table.sql);
			continue;
		}
		const present = new Set(columns(db, table.name).map((column) => column.name));
		for (const column of want.columns.get(table.name)!) {
			if (present.has(column.name)) continue;
			// SQLite adds a NOT NULL column only with a default; without one it is added nullable rather than not at all.
			const notNull = column.notnull && column.dflt_value !== null ? " NOT NULL" : "";
			const fallback = column.dflt_value !== null ? ` DEFAULT ${column.dflt_value}` : "";
			steps.push(
				`ALTER TABLE ${quote(table.name)} ADD COLUMN ${quote(column.name)} ${column.type}${notNull}${fallback}`,
			);
		}
	}
	for (const object of want.objects.filter((each) => each.type !== "table"))
		if (!have.has(object.name)) steps.push(object.sql);
	return steps;
}

/** Whether `db` is ours with all of `SCHEMA` and its full-text index: then opening it needs no write. */
export function schemaCurrent(db: DatabaseSync): boolean {
	return pragma(db, "application_id") === AGENT_APPLICATION_ID && missing(db).length === 0 && ftsWhole(db);
}

/**
 * Adds to `db` what `SCHEMA` has and it lacks (run it inside one write transaction), refusing another app's file. Then
 * makes sure the memory full-text index exists when SQLite has FTS5; returns whether it does.
 */
export function ensureSchema(db: DatabaseSync, file: string): { fts: boolean } {
	const applicationId = pragma(db, "application_id");
	if (applicationId !== AGENT_APPLICATION_ID) {
		const tables = db
			.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' LIMIT 1")
			.get();
		if (applicationId !== 0 || tables !== undefined)
			throw new AgentDbError(`${file} is not an Octocode agent database; set OCTOCODE_AGENT_DB to another file.`);
		db.exec(`PRAGMA application_id=${AGENT_APPLICATION_ID}`);
	}
	for (const step of missing(db)) db.exec(step);
	return { fts: ensureFts(db) };
}

const FTS_NAMES = ["memories_fts", "memories_fts_insert", "memories_fts_delete", "memories_fts_update"];
const ftsWhole = (db: DatabaseSync) => {
	const present = new Set(
		(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'memories_fts%'").all() as Array<{ name: string }>).map(
			(row) => row.name,
		),
	);
	return FTS_NAMES.every((name) => present.has(name));
};

/**
 * The optional FTS5 index over memories (external content, kept in sync by triggers), created whole when any part of
 * it is missing. False when this SQLite lacks FTS5 (then nothing is touched, even an index another process made).
 */
function ensureFts(db: DatabaseSync): boolean {
	if (ftsWhole(db)) return true;
	db.exec("SAVEPOINT fts");
	try {
		for (const trigger of FTS_NAMES.slice(1)) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
		db.exec("DROP TABLE IF EXISTS memories_fts");
		db.exec(FTS);
		db.exec("RELEASE fts");
		return true;
	} catch {
		db.exec("ROLLBACK TO fts");
		db.exec("RELEASE fts");
		return false;
	}
}
