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

/** Runs `work` with this connection waiting at most `ms` for another process's lock, then restores its wait. */
export function withBusyTimeout<T>(db: Sqlite.DatabaseSync, ms: number, work: () => T): T {
	const previous = num((db.prepare("PRAGMA busy_timeout").get() as Row | undefined)?.timeout);
	db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(ms))}`);
	try {
		return work();
	} finally {
		db.exec(`PRAGMA busy_timeout=${previous}`);
	}
}
