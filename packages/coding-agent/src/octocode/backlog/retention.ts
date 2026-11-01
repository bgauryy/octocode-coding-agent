import { type AgentDb, type HistoryTable, history, num, type Row } from "../agentdb/api.ts";
import { DAY_MS, HOUR_MS } from "../shared/util.ts";
import {
	ARCHIVE_AFTER_MS,
	ARCHIVE_KEEP_MS,
	type ArchiveRow,
	appendArchive,
	archiveSource,
	type Family,
	trimArchive,
} from "./history-archive.ts";

/**
 * History housekeeping: rows of the history tables older than 14 days move from the agent database into gzip monthly
 * JSONL files under the Octocode home (`AgentDb.archiveDir`), and archived rows older than 30 days are dropped. Backlog
 * items, notes and comments are never deleted by age. The windows are constants, not settings: one database and one
 * archive serve every repository and process, so a per-project value could prune another project's history.
 */
const FAMILIES: ReadonlyArray<{ table: HistoryTable; family: Family; key: (row: Row) => string }> = [
	{ table: "backlog_audits", family: "audits", key: (row) => String(row.id) },
	{ table: "config_audits", family: "config-audits", key: (row) => String(row.id) },
	{
		table: "workspace_commands",
		family: "workspace-commands",
		key: (row) => JSON.stringify([row.repo_key, row.session_id, row.id]),
	},
];

/** Rows per batch: each batch is one short write transaction, so another process never waits long. */
const BATCH = 5000;
/** How long a housekeeping write waits for another process's lock before it gives up until the next run. */
const QUICK_BUSY_MS = 100;
/** A skipped or failed run is retried after this long; a finished one after a day. */
const RETRY_MS = HOUR_MS;

export interface HousekeepingResult {
	/** Rows written to the archive (rows already past the keep window are deleted without being archived). */
	archived: number;
	deleted: number;
	/** Set when the run stopped early: the database or an archive file was held by another process. */
	skipped?: "busy" | "locked";
}

const lockHeld = (error: unknown) => ["ELOCKED", "ECOMPROMISED"].includes(String((error as { code?: unknown }).code));

/**
 * Runs one housekeeping pass at time `now`. Each batch is written to the archive before it is deleted from the
 * database, so a crash between the two leaves a row in both (readers keep one) rather than in neither. A database or
 * archive file held by another process ends the pass early without an error.
 */
export function archiveHistory(agentDb: AgentDb, now: number): HousekeepingResult {
	const result: HousekeepingResult = { archived: 0, deleted: 0 };
	const { db } = agentDb;
	const cutoff = now - ARCHIVE_AFTER_MS;
	const source = archiveSource(agentDb);
	try {
		trimArchive(agentDb.archiveDir, now);
		history.withBusyTimeout(db, QUICK_BUSY_MS, () => {
			for (const { table, family, key } of FAMILIES) {
				const oldest = history.oldestAt(db, table);
				if (oldest === undefined || oldest >= cutoff) continue;
				for (;;) {
					const rows = history.rowsBefore(db, table, cutoff, BATCH);
					const kept = rows.filter((row) => num(row.at) >= now - ARCHIVE_KEEP_MS);
					appendArchive(
						agentDb.archiveDir,
						family,
						// History tables hold text, integers and NULL only.
						kept.map((row) => ({ db: source, id: key(row), at: num(row.at), row: row as ArchiveRow })),
						now,
					);
					result.archived += kept.length;
					result.deleted += agentDb.transaction(() => history.deleteRows(db, table, rows));
					if (rows.length < BATCH) break;
				}
			}
		});
	} catch (error) {
		if (history.isBusy(error)) return { ...result, skipped: "busy" };
		if (lockHeld(error)) return { ...result, skipped: "locked" };
		throw error;
	}
	return result;
}

/** When each database file (this process) next runs housekeeping. */
const due = new Map<string, number>();

/**
 * Runs `archiveHistory` for the database at most once a day per process, after the current call returns, so it is never
 * on the open path or inside a user's write. A busy database or a failure is retried an hour later. Background work:
 * an error never reaches the caller.
 */
export function scheduleHistoryArchive(agentDb: () => AgentDb, now: () => number = Date.now): void {
	let target: AgentDb;
	try {
		target = agentDb();
	} catch {
		// An unreadable database: the call that opened the backlog reports why.
		return;
	}
	const at = now();
	if ((due.get(target.file) ?? 0) > at) return;
	due.set(target.file, at + DAY_MS);
	setImmediate(() => {
		if (!target.db.isOpen) {
			due.delete(target.file);
			return;
		}
		try {
			if (archiveHistory(target, now()).skipped) due.set(target.file, now() + RETRY_MS);
		} catch {
			// Housekeeping only (an unwritable archive folder, a damaged archive file): the rows stay in the database.
			due.set(target.file, now() + RETRY_MS);
		}
	}).unref();
}
