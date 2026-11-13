import { createRequire } from "node:module";
import type * as Sqlite from "node:sqlite";
import { num, type Row } from "./rows.ts";

/** node:sqlite prints an ExperimentalWarning on some Node versions; that would land in the terminal UI. */
export function loadSqlite(): typeof Sqlite {
	const emit = process.emitWarning;
	process.emitWarning = (warning: string | Error, ...rest: unknown[]) => {
		const text = typeof warning === "string" ? warning : warning.message;
		if (/sqlite/i.test(text)) return;
		return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
	};
	try {
		return createRequire(import.meta.url)("node:sqlite") as typeof Sqlite;
	} finally {
		process.emitWarning = emit;
	}
}

/**
 * Opens another program's SQLite database read-only (`team/peer-leases.ts` reads the agents-communication package's
 * leases). Never an agent database: those open through `openDatabase`/`sharedDatabase`.
 */
export function openReadOnlyDb(file: string): Sqlite.DatabaseSync {
	const { DatabaseSync: Database } = loadSqlite();
	return new Database(file, { readOnly: true });
}

/** SQLite's "database is locked" (`SQLITE_BUSY`, extended codes included); false for anything else, null included. */
export const isBusy = (error: unknown): boolean =>
	(Number((error as { errcode?: unknown } | null | undefined)?.errcode) & 0xff) === 5;

const nap = new Int32Array(new SharedArrayBuffer(4));
/** How long a contended `BEGIN IMMEDIATE` sleeps between tries: shorter than a peer's short write transaction. */
const RETRY_MS = 1;

/** This connection's `busy_timeout`: how long a statement may wait for another connection's lock. */
const busyTimeout = (db: Sqlite.DatabaseSync): number =>
	num((db.prepare("PRAGMA busy_timeout").get() as Row | undefined)?.timeout);

/**
 * `BEGIN IMMEDIATE` within the connection's own `busy_timeout`, retried every millisecond instead of through SQLite's
 * busy handler. That handler sleeps 1, 2, 5, 10 … 100 ms between tries, so a thread that meets a peer's short
 * transactions sleeps past the gaps between them. The budget is the connection's `busy_timeout` at the call (0 tries
 * once); when it runs out the last SQLITE_BUSY error is thrown, as SQLite's handler would. Only the BEGIN waits this way:
 * the statements inside the transaction keep the connection's timeout, which is restored before this returns.
 */
export function beginImmediate(db: Sqlite.DatabaseSync): void {
	const budget = busyTimeout(db);
	if (budget <= 0) {
		db.exec("BEGIN IMMEDIATE");
		return;
	}
	const deadline = performance.now() + budget;
	db.exec("PRAGMA busy_timeout=0");
	let began = false;
	let failure: unknown;
	while (!began && failure === undefined) {
		try {
			db.exec("BEGIN IMMEDIATE");
			began = true;
		} catch (error) {
			const left = deadline - performance.now();
			if (!isBusy(error) || left <= 0) failure = error ?? new Error("BEGIN IMMEDIATE failed");
			else Atomics.wait(nap, 0, 0, Math.min(RETRY_MS, left));
		}
	}
	try {
		db.exec(`PRAGMA busy_timeout=${budget}`);
	} catch (error) {
		// The caller only rolls back a transaction it knows it holds.
		if (began) db.exec("ROLLBACK");
		throw error;
	}
	if (!began) throw failure;
}

/** Runs `work` with this connection waiting at most `ms` for another process's lock, then restores its wait. */
export function withBusyTimeout<T>(db: Sqlite.DatabaseSync, ms: number, work: () => T): T {
	const previous = busyTimeout(db);
	db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(ms))}`);
	try {
		return work();
	} finally {
		db.exec(`PRAGMA busy_timeout=${previous}`);
	}
}

/**
 * `write` without waiting for another connection's lock, for a write nothing depends on (a periodic sample, a history
 * count): it is not worth holding the thread that also draws the screen, so a locked database raises the busy error at
 * once (`isBusy`) and the caller skips the write.
 */
export function withoutWaiting<T>(db: Sqlite.DatabaseSync, write: () => T): T {
	return withBusyTimeout(db, 0, write);
}
