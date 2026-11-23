import type { DatabaseSync } from "node:sqlite";

/** The most source anchors one note revision keeps. */
export const MAX_MEMORY_SOURCES = 8;

/**
 * Records `anchors` (already validated text forms, at most `MAX_MEMORY_SOURCES`) as pending for revision `revision` of
 * note `memoryId`. Earlier pending rows of the note go: only the latest save can still be finalized.
 */
export function addPending(
	db: DatabaseSync,
	memoryId: number,
	revision: number,
	anchors: readonly string[],
	now: number,
): void {
	db.prepare("DELETE FROM memory_sources WHERE memory_id = ? AND state = 'pending'").run(memoryId);
	const insert = db.prepare(
		"INSERT OR IGNORE INTO memory_sources (memory_id, revision, anchor, state, created_at) VALUES (?, ?, ?, 'pending', ?)",
	);
	for (const anchor of anchors.slice(0, MAX_MEMORY_SOURCES)) insert.run(memoryId, revision, anchor, now);
}

/** Makes the pending rows of `memoryId` at `revision` final and drops the note's rows of other revisions. */
export function finalize(db: DatabaseSync, memoryId: number, revision: number): void {
	db.prepare("DELETE FROM memory_sources WHERE memory_id = ? AND revision <> ?").run(memoryId, revision);
	db.prepare(
		"UPDATE memory_sources SET state = 'final' WHERE memory_id = ? AND revision = ? AND state = 'pending'",
	).run(memoryId, revision);
}

/**
 * Settles pending rows left by an interrupted save: those whose revision is the saved note's current `updated_at` are
 * finalized, the others dropped. Idempotent; returns how many rows were finalized.
 */
export function reconcile(db: DatabaseSync): number {
	// Older revisions of a note whose pending rows match its saved content go first, as `finalize` drops them.
	db.prepare(
		`DELETE FROM memory_sources WHERE memory_id IN (
			SELECT s.memory_id FROM memory_sources s JOIN memories m ON m.id = s.memory_id AND m.updated_at = s.revision
			WHERE s.state = 'pending'
		) AND revision <> (SELECT updated_at FROM memories WHERE id = memory_id)`,
	).run();
	const finalized = db
		.prepare(
			`UPDATE memory_sources SET state = 'final' WHERE state = 'pending'
			AND revision = (SELECT updated_at FROM memories WHERE id = memory_id)`,
		)
		.run().changes;
	db.prepare("DELETE FROM memory_sources WHERE state = 'pending'").run();
	return Number(finalized);
}

/** The final anchors of `memoryId` at `revision`, oldest first: links whose note still has the content they were made for. */
export function finalAnchors(db: DatabaseSync, memoryId: number, revision: number): string[] {
	return db
		.prepare(
			"SELECT anchor FROM memory_sources WHERE memory_id = ? AND revision = ? AND state = 'final' ORDER BY created_at, anchor LIMIT ?",
		)
		.all(memoryId, revision, MAX_MEMORY_SOURCES)
		.map((row) => String(row.anchor));
}

/** Every row of `memoryId`, for tests and diagnostics. */
export function rowsOf(db: DatabaseSync, memoryId: number): Array<{ revision: number; anchor: string; state: string }> {
	return db
		.prepare("SELECT revision, anchor, state FROM memory_sources WHERE memory_id = ? ORDER BY revision, anchor")
		.all(memoryId)
		.map((row) => ({ revision: Number(row.revision), anchor: String(row.anchor), state: String(row.state) }));
}
