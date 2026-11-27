import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "./transaction.ts";
import * as transcripts from "./transcripts.ts";

export interface ExpireCounts {
	transcripts: number;
	entries: number;
	events: number;
	timers: number;
}

/**
 * Age rule for the transcript mirror and event log of sessions whose transcript file is gone. The database cannot see
 * the filesystem, so the caller (the sweep, which lists the session files) names the `sessionIds` without a file; the
 * rows' own timestamps then decide, and a session whose rows were written after `before` (ms since epoch) is kept even
 * if the caller's listing was stale or its checkout was briefly unmounted:
 *
 * - a transcript in the mirror (`mirror`: `session_transcripts` with its `session_entries`) goes when its last save,
 *   `mtime` (the file's modification time, ns, at that save), is before `before`; the `sessions` row and compaction
 *   summaries stay (`sessions.erase` removes those);
 * - an `agent_events` row of those sessions goes when its own `time` is before `before`;
 * - a `timers` row of those sessions goes when it was last updated before `before`: no file is left to resume and fire it.
 *
 * The mirror's transaction runs first, then the coordination file's, then each of `workspaceFiles` (the files holding
 * workspace rows apart from `db`) in its own; call it outside a coordination transaction.
 */
export function orphans(
	db: DatabaseSync,
	mirror: DatabaseSync,
	sessionIds: readonly string[],
	before: number,
	workspaceFiles: readonly DatabaseSync[] = [],
): ExpireCounts {
	const counts: ExpireCounts = { transcripts: 0, entries: 0, events: 0, timers: 0 };
	if (sessionIds.length === 0) return counts;
	Object.assign(
		counts,
		inTransaction(mirror, () => transcripts.expire(mirror, sessionIds, before)),
	);
	const json = JSON.stringify([...new Set(sessionIds)]);
	for (const file of [db, ...workspaceFiles])
		inTransaction(file, () => {
			counts.events += Number(
				file
					.prepare("DELETE FROM agent_events WHERE session_id IN (SELECT value FROM json_each(?1)) AND time < ?2")
					.run(json, new Date(before).toISOString()).changes,
			);
			counts.timers += Number(
				file
					.prepare("DELETE FROM timers WHERE session_id IN (SELECT value FROM json_each(?1)) AND updated_at < ?2")
					.run(json, before).changes,
			);
		});
	return counts;
}
