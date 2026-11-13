import type { DatabaseSync } from "node:sqlite";
import * as transcripts from "./transcripts.ts";

/**
 * `session_forks`: the fork edges the host recorded when it created a fork (child, its file, parent), in the
 * coordination file. Functions that also read the transcript mirror take its connection as `mirror`.
 */

/**
 * Only the host operation which creates a fork supplies this edge. An imported JSONL header cannot grant archive access.
 * Recording the same edge again (a retry whose first commit lost its acknowledgement) succeeds; a different edge for the
 * child, or a child whose stored transcript is another file, is refused.
 */
export function link(db: DatabaseSync, mirror: DatabaseSync, child: string, file: string, parent: string): void {
	const stored = transcripts.stamp(mirror, child)?.file;
	const result =
		stored === undefined || stored === file
			? db
					.prepare(`INSERT INTO session_forks(child_id,child_file,parent_id) VALUES (?,?,?)
		ON CONFLICT(child_id) DO UPDATE SET child_file=excluded.child_file
		WHERE session_forks.child_file=excluded.child_file AND session_forks.parent_id=excluded.parent_id`)
					.run(child, file, parent)
			: { changes: 0 };
	if (!result.changes) throw new Error("Another transcript already uses this session ID");
}

/** The parent a fork edge names for `child`, if one was recorded. */
export function parentOf(db: DatabaseSync, child: string): string | undefined {
	const row = db.prepare("SELECT parent_id FROM session_forks WHERE child_id=?").get(child);
	return row ? String(row.parent_id) : undefined;
}

/** A materialized fork inherited these compaction entries from its saved parent snapshot. */
export function inheritedCompactions(db: DatabaseSync, mirror: DatabaseSync, child: string): Set<string> | undefined {
	const parent = parentOf(db, child);
	return parent === undefined ? undefined : new Set(transcripts.entryIds(mirror, parent, "compaction"));
}

/**
 * Follow recorded edges, anchoring the first one to the same checkout and transcript file that the host actually opened:
 * the child's stored transcript file when the mirror has one, else the file the edge recorded.
 */
export function lineage(
	db: DatabaseSync,
	mirror: DatabaseSync,
	child: string,
	file: string,
	workspace: string,
): string[] {
	const stored = transcripts.stamp(mirror, child)?.file ?? null;
	return db
		.prepare(`WITH RECURSIVE parents(id,depth) AS (
		SELECT f.parent_id,1 FROM session_forks f JOIN sessions s ON s.id=f.child_id
		WHERE f.child_id=? AND COALESCE(?,f.child_file)=? AND s.workspace_id=?
		UNION ALL SELECT f.parent_id,p.depth+1 FROM parents p JOIN session_forks f ON f.child_id=p.id WHERE p.depth<32)
		SELECT id FROM parents ORDER BY depth`)
		.all(child, stored, file, workspace)
		.map((row) => String(row.id));
}
