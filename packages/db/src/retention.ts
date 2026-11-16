import type { AgentDb } from "./db.ts";
import * as agentEvents from "./queries/agent-events.ts";
import * as agentRuns from "./queries/agent-runs.ts";
import * as history from "./queries/history.ts";
import * as timers from "./queries/timers.ts";
import type { HistoryTable } from "./queries/history.ts";
import { isBusy, withoutWaiting } from "./sqlite.ts";
import { num, type Row } from "./rows.ts";
import {
	DEFAULT_HISTORY_WINDOWS,
	type HistoryWindows,
	windowsMs,
	type ArchiveRow,
	appendArchive,
	archiveSource,
	type Family,
	trimArchive,
} from "./history-archive.ts";

/**
 * History housekeeping: rows of the history tables older than `archiveAfterDays` (default 14) move from the agent
 * database into gzip monthly JSONL files under the Octocode home (`AgentDb.archiveDir`), and archived rows older than
 * `keepDays` (default 30, 0 = never) are dropped; agent runs (`agent_runs`) and agent events (`agent_events`, except each workspace's newest) are dropped at `keepDays` without an archive. Backlog items, notes and comments are never deleted by age. The caller
 * passes the windows (`HistoryWindows`): one database and one archive serve every repository and process, so the value
 * must be the user's global one, never a per-project setting that could prune another project's history.
 */
const FAMILIES: ReadonlyArray<{ table: HistoryTable; family: Family; key: (row: Row) => string }> = [
	{ table: "backlog_audits", family: "audits", key: (row) => String(row.id) },
	{ table: "config_audits", family: "config-audits", key: (row) => String(row.id) },
	{
		table: "workspace_commands",
		family: "workspace-commands",
		key: (row) => JSON.stringify([row.workspace_id, row.session_id, row.id]),
	},
];

/** Rows per batch: each batch is one short write transaction, so another process never waits long. */
const BATCH = 5000;

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
export function archiveHistory(
	agentDb: AgentDb,
	now: number,
	windows: HistoryWindows = DEFAULT_HISTORY_WINDOWS,
	assertActive: () => void = () => {},
): HousekeepingResult {
	const { archiveAfterMs, keepMs } = windowsMs(windows);
	const result: HousekeepingResult = { archived: 0, deleted: 0 };
	const { db } = agentDb;
	const cutoff = now - archiveAfterMs;
	const source = archiveSource(agentDb);
	try {
		assertActive();
		trimArchive(agentDb.archiveDir, now, keepMs, assertActive);
		withoutWaiting(db, () => {
			history.ensureAtIndexes(db);
			for (const { table, family, key } of FAMILIES) {
				const oldest = history.oldestAt(db, table);
				if (oldest === undefined || oldest >= cutoff) continue;
				for (;;) {
					assertActive();
					const rows = history.rowsBefore(db, table, cutoff, BATCH);
					const kept = rows.filter((row) => num(row.at) >= now - keepMs);
					appendArchive(
						agentDb.archiveDir,
						family,
						// History tables hold text, integers and NULL only.
						kept.map((row) => ({ db: source, id: key(row), at: num(row.at), row: row as ArchiveRow })),
						now,
						keepMs,
						assertActive,
					);
					result.archived += kept.length;
					assertActive();
					result.deleted += agentDb.transaction(() => history.deleteRows(db, table, rows));
					if (rows.length < BATCH) break;
				}
			}
			// Agent runs are the audit of who ran what: they stay for the keep window and are not archived.
			assertActive();
			if (Number.isFinite(keepMs)) result.deleted += agentDb.transaction(() => agentRuns.purgeBefore(db, now - keepMs));
			// The agent event log: rows past the window go in batches; each workspace's newest event stays (see `agentEvents.purgeBefore`).
			if (Number.isFinite(keepMs))
				for (;;) {
					assertActive();
					const purged = agentDb.transaction(() => agentEvents.purgeBefore(db, now - keepMs, BATCH));
					result.deleted += purged;
					if (purged < BATCH) break;
				}
			// Timers likewise: ended ones, and active ones left overdue and untouched for the whole window.
			if (Number.isFinite(keepMs)) result.deleted += agentDb.transaction(() => timers.purgeBefore(db, now - keepMs));
		});
	} catch (error) {
		if (isBusy(error)) return { ...result, skipped: "busy" };
		if (lockHeld(error)) return { ...result, skipped: "locked" };
		throw error;
	}
	return result;
}
