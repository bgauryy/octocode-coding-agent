import type { DatabaseSync } from "node:sqlite";

const CHUNK = 500;

/**
 * How many child runs each of `sessionIds` started directly (`parent_session_id`), in one grouped query per 500 ids;
 * sessions with none are absent.
 */
export function countBySession(db: DatabaseSync, sessionIds: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (let at = 0; at < sessionIds.length; at += CHUNK) {
		const chunk = sessionIds.slice(at, at + CHUNK);
		const rows = db
			.prepare(
				`SELECT parent_session_id AS sid, COUNT(*) AS n FROM agent_runs
				 WHERE kind = 'child' AND parent_session_id IN (${chunk.map(() => "?").join(",")}) GROUP BY parent_session_id`,
			)
			.all(...chunk) as { sid: string; n: number }[];
		for (const { sid, n } of rows) counts.set(sid, n);
	}
	return counts;
}
