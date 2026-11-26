import type { DatabaseSync } from "node:sqlite";

export function set(db: DatabaseSync, version: number): void {
	db.exec(`PRAGMA user_version=${version}`);
}

/** The one-row table holding the file's oldest compatible reader. Created additively, so any build can add it. */
const META =
	"CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), min_reader INTEGER NOT NULL)";

/** The stored `min_reader`, or undefined when the file has no stamp (written before stamps existed). Writes nothing. */
export function minReader(db: DatabaseSync): number | undefined {
	const table = db.prepare("SELECT 1 AS found FROM sqlite_schema WHERE type='table' AND name='schema_meta'").get();
	if (!table) return undefined;
	const row = db.prepare("SELECT min_reader FROM schema_meta WHERE id = 1").get();
	return row ? Number(row.min_reader) : undefined;
}

/** Stores the oldest schema version that can still read this file. */
export function setMinReader(db: DatabaseSync, version: number): void {
	db.exec(META);
	db.prepare(
		"INSERT INTO schema_meta (id, min_reader) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET min_reader = excluded.min_reader",
	).run(version);
}

/** A consistent copy of the database as of now, committed WAL frames included, while other connections keep writing. */
export function vacuumInto(db: DatabaseSync, target: string): void {
	db.prepare("VACUUM INTO ?").run(target);
}
