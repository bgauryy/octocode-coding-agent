import type { DatabaseSync } from "node:sqlite";
import type { Row } from "../rows.ts";

/** Records that `agent` changed each of `paths` (workspace-relative) with `tool` at `at`. */
export function record(
	db: DatabaseSync,
	workspace: string,
	paths: string[],
	agent: string,
	tool: string,
	at: number,
): void {
	const insert = db.prepare("INSERT INTO edits (workspace, path, agent, tool, at) VALUES (?, ?, ?, ?, ?)");
	for (const file of paths) insert.run(workspace, file, agent, tool, at);
}

/**
 * The changes after `since` grouped by path, agent and tool, newest first (with their last time and count), optionally
 * only by `agent`.
 */
export function changesSince(db: DatabaseSync, workspace: string, since: number, agent?: string): Row[] {
	const byAgent = agent === undefined ? "" : " AND agent = ?";
	return db
		.prepare(
			// Writes within one millisecond share `at`; the row id, assigned in insertion order, decides which is newer.
			`SELECT path, agent, tool, MAX(at) AS at, COUNT(*) AS count, MAX(rowid) AS seq FROM edits WHERE workspace = ? AND at > ?${byAgent} GROUP BY path, agent, tool ORDER BY at DESC, seq DESC, path`,
		)
		.all(workspace, since, ...(agent === undefined ? [] : [agent]));
}

/** Gives the changes `from` made at or after `since` to `to`. */
export function reassign(db: DatabaseSync, workspace: string, from: string, to: string, since: number): void {
	db.prepare("UPDATE edits SET agent = ? WHERE workspace = ? AND agent = ? AND at >= ?").run(
		to,
		workspace,
		from,
		since,
	);
}

/** Deletes the changes recorded before `before`. */
export function pruneBefore(db: DatabaseSync, before: number): void {
	db.prepare("DELETE FROM edits WHERE at < ?").run(before);
}
