import type { DatabaseSync } from "node:sqlite";
import { AgentDbError } from "./schema.ts";
import { isBusy, loadSqlite, openReadOnlyDb } from "./sqlite.ts";

/**
 * Throws `AgentDbError` naming the holders when another connection has `target` open. Every open connection to a
 * WAL file shares a lock that only the last one to close can drop, so switching the journal mode (which needs all of
 * them gone) fails while any process uses the file. The switch changes nothing when it fails; when it succeeds nobody
 * was using the file and the caller retires it.
 */
export function refuseIfInUse(target: string, version: number): void {
	const { DatabaseSync: Database } = loadSqlite();
	const probe = new Database(target, { timeout: 0 });
	let held = false;
	try {
		probe.exec("PRAGMA locking_mode=EXCLUSIVE");
		const row = probe.prepare("PRAGMA journal_mode=DELETE").get() as { journal_mode?: string } | undefined;
		held = row?.journal_mode?.toLowerCase() === "wal";
	} catch (error) {
		if (!isBusy(error)) throw error;
		held = true;
	} finally {
		probe.close();
	}
	if (!held) return;
	const pids = livePids(target);
	const who = pids.length > 0 ? `process ${pids.join(", ")}` : "another process";
	throw new AgentDbError(
		`${target} has Octocode schema version ${version}, older than this Octocode's, and is in use by ${who}: it was left untouched. Quit those Octocode processes (or run the Octocode version that matches the file) and retry, or select another file with OCTOCODE_AGENT_DB.`,
	);
}

/** Pids of live agents recorded in `target`, for the refusal message; empty when the table cannot be read. */
function livePids(target: string): number[] {
	let reader: DatabaseSync | undefined;
	try {
		reader = openReadOnlyDb(target);
		const rows = reader.prepare("SELECT DISTINCT pid FROM agents").all() as Array<{ pid: number }>;
		return rows.map((row) => row.pid).filter(isAlive);
	} catch {
		// The message only loses the pids: an old schema may lack the table, or the file may be busy.
		return [];
	} finally {
		reader?.close();
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
