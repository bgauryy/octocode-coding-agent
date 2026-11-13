import type { DatabaseSync } from "node:sqlite";
import * as meta from "./meta.ts";

/** The `meta` key holding the oldest schema version that can use this file; no row means the file's own version. */
const READABLE_FROM = "schema_readable_from";

export function current(db: DatabaseSync): number {
	return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

export function set(db: DatabaseSync, version: number): void {
	db.exec(`PRAGMA user_version=${version}`);
}

/** The compatibility floor a file records, if any. A newer file need not have a `meta` table this Octocode knows. */
export function readableFrom(db: DatabaseSync): number | undefined {
	if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='meta'").get()) return undefined;
	const floor = Number(meta.read(db, READABLE_FROM));
	return Number.isInteger(floor) && floor > 0 ? floor : undefined;
}

export function setReadableFrom(db: DatabaseSync, version: number): void {
	meta.write(db, READABLE_FROM, String(version));
}

/** A consistent copy of the database as of now, committed WAL frames included, while other connections keep writing. */
export function vacuumInto(db: DatabaseSync, target: string): void {
	db.prepare("VACUUM INTO ?").run(target);
}

/** `PRAGMA quick_check`: whether a copy is a whole, readable database (a torn or truncated one is not). */
export function wholeCopy(db: DatabaseSync): boolean {
	const rows = db.prepare("PRAGMA quick_check").all() as { quick_check?: unknown }[];
	return rows.length === 1 && rows[0]?.quick_check === "ok";
}
