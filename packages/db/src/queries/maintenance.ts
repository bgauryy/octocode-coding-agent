import type { DatabaseSync } from "node:sqlite";
import { num, type Row } from "../rows.ts";
import { isBusy, withBusyTimeout } from "../sqlite.ts";

/** What a maintenance step did. A step that another connection blocks is `busy` (nothing failed, retry later). */
export interface MaintenanceResult {
	busy: boolean;
	/** Database file size in bytes before and after (pages x page size; the WAL file is separate). */
	bytesBefore: number;
	bytesAfter: number;
}

const size = (db: DatabaseSync): number => {
	const one = (name: string) => num((db.prepare(`PRAGMA ${name}`).get() as Row | undefined)?.[name]);
	return one("page_count") * one("page_size");
};

/**
 * `PRAGMA wal_checkpoint(TRUNCATE)`: copies the WAL into the database file and truncates it. A reader or writer on
 * another connection can stop it; that comes back as `busy: true`, not as an error (the WAL stays valid and is
 * checkpointed by the next run). It waits at most `busyMs` for locks; with `0` it never waits and, like a PASSIVE
 * checkpoint, copies what it can without blocking anyone.
 */
export function checkpoint(db: DatabaseSync, busyMs = 1000): MaintenanceResult {
	const bytesBefore = size(db);
	try {
		const row = withBusyTimeout(db, busyMs, () => db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()) as
			| Row
			| undefined;
		return { busy: num(row?.busy) === 1, bytesBefore, bytesAfter: size(db) };
	} catch (error) {
		if (isBusy(error)) return { busy: true, bytesBefore, bytesAfter: size(db) };
		throw error;
	}
}

/**
 * A full `VACUUM` (rewrites the file; for user-initiated purges, not housekeeping), then a TRUNCATE checkpoint so the
 * file on disk shrinks. VACUUM needs the only write lock and no open read transaction elsewhere: while another connection
 * or process holds one it comes back `busy: true` after at most `busyMs`, leaving the database unchanged. It throws when
 * called inside a transaction (SQLite refuses). Other errors propagate.
 */
export function vacuum(db: DatabaseSync, busyMs = 5000): MaintenanceResult {
	if (db.isTransaction) throw new Error("VACUUM cannot run inside a transaction.");
	const bytesBefore = size(db);
	try {
		withBusyTimeout(db, busyMs, () => db.exec("VACUUM"));
	} catch (error) {
		if (isBusy(error)) return { busy: true, bytesBefore, bytesAfter: size(db) };
		throw error;
	}
	const flushed = checkpoint(db, busyMs);
	return { busy: flushed.busy, bytesBefore, bytesAfter: flushed.bytesAfter };
}
