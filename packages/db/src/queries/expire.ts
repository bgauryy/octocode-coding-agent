import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "./transaction.ts";

export interface ExpireCounts {
	transcripts: number;
	entries: number;
	events: number;
}

/**
 * Age rule for the transcript mirror and event log of sessions whose transcript file is gone. The database cannot see
 * the filesystem, so the caller (the sweep, which lists the session files) names the `sessionIds` without a file; the
 * rows' own timestamps then decide, and a session whose rows were written after `before` (ms since epoch) is kept even
 * if the caller's listing was stale or its checkout was briefly unmounted:
 *
 * - a transcript (`session_transcripts` with its `session_entries`) goes when its last save, `mtime` (the file's
 *   modification time, ns, at that save), is before `before`; the `sessions` row and compaction summaries stay (`sessions.erase` removes those);
 * - an `agent_events` row of those sessions goes when its own `time` is before `before`.
 */
export function orphans(db: DatabaseSync, sessionIds: readonly string[], before: number): ExpireCounts {
	const counts: ExpireCounts = { transcripts: 0, entries: 0, events: 0 };
	if (sessionIds.length === 0) return counts;
	const json = JSON.stringify([...new Set(sessionIds)]);
	inTransaction(db, () => {
		const stale = `session_id IN (SELECT value FROM json_each(?1)) AND mtime GLOB '[0-9]*' AND CAST(mtime AS INTEGER) / 1000000 < ?2`;
		counts.entries = Number(
			db
				.prepare(
					`DELETE FROM session_entries WHERE session_id IN (SELECT session_id FROM session_transcripts WHERE ${stale})`,
				)
				.run(json, before).changes,
		);
		counts.transcripts = Number(db.prepare(`DELETE FROM session_transcripts WHERE ${stale}`).run(json, before).changes);
		counts.events = Number(
			db
				.prepare("DELETE FROM agent_events WHERE session_id IN (SELECT value FROM json_each(?1)) AND time < ?2")
				.run(json, new Date(before).toISOString()).changes,
		);
	});
	return counts;
}

/** Deletes every `agent_events` row written before `before` (ms since epoch), whatever its session; returns how many. */
export function events(db: DatabaseSync, before: number): number {
	return Number(db.prepare("DELETE FROM agent_events WHERE time < ?").run(new Date(before).toISOString()).changes);
}
