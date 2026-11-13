import type { DatabaseSync } from "node:sqlite";

export function set(db: DatabaseSync, version: number): void {
	db.exec(`PRAGMA user_version=${version}`);
}

/** A consistent copy of the database as of now, committed WAL frames included, while other connections keep writing. */
export function vacuumInto(db: DatabaseSync, target: string): void {
	db.prepare("VACUUM INTO ?").run(target);
}
