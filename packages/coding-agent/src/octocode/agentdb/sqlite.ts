import { createRequire } from "node:module";
import type * as Sqlite from "node:sqlite";

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
 * leases). Never an agent database: those open through `openAgentDb`/`sharedAgentDb`.
 */
export function openReadOnlyDb(file: string): Sqlite.DatabaseSync {
	const { DatabaseSync: Database } = loadSqlite();
	return new Database(file, { readOnly: true });
}
