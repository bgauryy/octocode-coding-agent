import type { DatabaseSync } from "node:sqlite";
import type { Row } from "../rows.ts";

/**
 * The transcript mirror's `compaction_summaries` (`schema-mirror.ts`): every function takes the mirror's connection
 * (`AgentDb.mirror.db`). `workspace_id` and `session_id` name rows of the coordination file.
 */

export interface CompactionSummary {
	workspace: string;
	sessionId: string;
	entryId: string;
	summary: string;
	committedAt: number | null;
	originVerified: boolean;
	metadata: Record<string, unknown>;
	detailFile: string | null;
	detailState: "missing" | "present" | "expired";
}
export interface SummaryRow extends CompactionSummary {
	seq: number;
}

function decode(row: Row): SummaryRow {
	return {
		seq: Number(row.seq),
		workspace: String(row.workspace_id),
		sessionId: String(row.session_id),
		entryId: String(row.entry_id),
		summary: String(row.summary),
		committedAt: row.committed_at === null ? null : Number(row.committed_at),
		originVerified: Boolean(row.origin_verified),
		metadata: JSON.parse(String(row.metadata)) as Record<string, unknown>,
		detailFile: row.detail_file as string | null,
		detailState: row.detail_state as CompactionSummary["detailState"],
	};
}

/** Repair may enrich metadata but must never resurrect an intentionally expired detail copy. */
export function save(db: DatabaseSync, value: CompactionSummary): void {
	db.prepare(`INSERT INTO compaction_summaries(workspace_id,session_id,entry_id,summary,committed_at,origin_verified,metadata,detail_file,detail_state)
		VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,entry_id) DO UPDATE SET
		summary=excluded.summary, committed_at=COALESCE(compaction_summaries.committed_at,excluded.committed_at),
		origin_verified=MAX(compaction_summaries.origin_verified,excluded.origin_verified), metadata=excluded.metadata,
		detail_file=COALESCE(excluded.detail_file,compaction_summaries.detail_file),
		detail_state=CASE WHEN compaction_summaries.detail_state='expired' THEN 'expired'
		WHEN excluded.detail_file IS NOT NULL THEN excluded.detail_state ELSE compaction_summaries.detail_state END`).run(
		value.workspace,
		value.sessionId,
		value.entryId,
		value.summary,
		value.committedAt,
		value.originVerified ? 1 : 0,
		JSON.stringify(value.metadata),
		value.detailFile,
		value.detailState,
	);
}

export function get(db: DatabaseSync, sessionId: string, entryId: string): SummaryRow | undefined {
	const row = db
		.prepare("SELECT * FROM compaction_summaries WHERE session_id=? AND entry_id=?")
		.get(sessionId, entryId) as Row | undefined;
	return row ? decode(row) : undefined;
}

export function forSession(db: DatabaseSync, sessionId: string): SummaryRow[] {
	return (db.prepare("SELECT * FROM compaction_summaries WHERE session_id=? ORDER BY seq").all(sessionId) as Row[]).map(
		decode,
	);
}

/** Mark before unlinking: a crash retries the unlink and cannot make repair re-create the copy. */
export function expire(db: DatabaseSync, sessionId: string, entryId: string): void {
	db.prepare("UPDATE compaction_summaries SET detail_state='expired' WHERE session_id=? AND entry_id=?").run(
		sessionId,
		entryId,
	);
}

export function expirable(db: DatabaseSync, before: number): SummaryRow[] {
	return (
		db
			.prepare(`SELECT * FROM compaction_summaries WHERE origin_verified=1 AND committed_at IS NOT NULL
		AND committed_at<=? AND detail_file IS NOT NULL`)
			.all(before) as Row[]
	).map(decode);
}

/** Include inherited history without broadening the workspace to the whole repository. */
export function visible(
	db: DatabaseSync,
	workspace: string,
	own: readonly string[],
	before: number,
	limit: number,
	keywords = "",
): SummaryRow[] {
	const words = keywords.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 16) ?? [];
	const terms = words.map(() => "(instr(lower(summary), lower(?)) > 0 OR instr(lower(metadata), lower(?)) > 0)");
	return (
		db
			.prepare(`SELECT * FROM compaction_summaries WHERE (workspace_id=? OR session_id IN (SELECT value FROM json_each(?)))
		AND seq<? ${terms.length ? `AND (${terms.join(" OR ")})` : ""} ORDER BY seq DESC LIMIT ?`)
			.all(workspace, JSON.stringify(own), before, ...words.flatMap((word) => [word, word]), limit) as Row[]
	).map(decode);
}

/** Session discovery survives loss or cleanup of every detail file and the transient session catalog. */
export function sessionIndex(
	db: DatabaseSync,
	workspace: string,
	own: readonly string[],
	before: number,
	limit: number,
): Array<{ sessionId: string; seq: number; committedAt: number | null }> {
	return (
		db
			.prepare(`SELECT session_id, MAX(seq) AS seq, MAX(committed_at) AS committed_at FROM compaction_summaries
		WHERE workspace_id=? OR session_id IN (SELECT value FROM json_each(?)) GROUP BY session_id
		HAVING MAX(seq)<? ORDER BY seq DESC LIMIT ?`)
			.all(workspace, JSON.stringify(own), before, limit) as Row[]
	).map((row) => ({
		sessionId: String(row.session_id),
		seq: Number(row.seq),
		committedAt: row.committed_at as number | null,
	}));
}

/** Whether a compaction summary of `sessionId` is stored. */
export function has(db: DatabaseSync, sessionId: string): boolean {
	return db.prepare("SELECT 1 FROM compaction_summaries WHERE session_id=?").get(sessionId) !== undefined;
}

/** Removes the summaries of the sessions `ids` (a user's deletion of those sessions); returns how many. */
export function erase(db: DatabaseSync, ids: readonly string[]): number {
	return Number(
		db
			.prepare("DELETE FROM compaction_summaries WHERE session_id IN (SELECT value FROM json_each(?))")
			.run(JSON.stringify([...new Set(ids)])).changes,
	);
}

/** Removes the summaries of `workspace` except those of the sessions in `kept` (`purge.workspace`); returns how many. */
export function purgeWorkspace(db: DatabaseSync, workspace: string, kept: readonly string[]): number {
	return Number(
		db
			.prepare(`DELETE FROM compaction_summaries WHERE workspace_id = ?
		AND COALESCE(session_id, '') NOT IN (SELECT value FROM json_each(?))`)
			.run(workspace, JSON.stringify([...new Set(kept)])).changes,
	);
}

/** Removes every summary except those of the sessions in `kept` (`purge.all`); returns how many. */
export function keepOnly(db: DatabaseSync, kept: readonly string[]): number {
	return Number(
		db
			.prepare("DELETE FROM compaction_summaries WHERE session_id NOT IN (SELECT value FROM json_each(?))")
			.run(JSON.stringify([...new Set(kept)])).changes,
	);
}
