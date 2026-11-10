import type { DatabaseSync } from "node:sqlite";
import { num, type Row } from "../rows.ts";

export type MemoryScope = "global" | "project" | "workspace";
export interface MemoryContext {
	repoKey: string;
	workspaceId?: string;
}
/** A read with `all` sees global notes, repository notes and this workspace's notes. */
export type ScopeFilter = MemoryScope | "all";
/** Narrows a list or count: only pinned memories, and none of the `exclude` ids (those already in context). */
export interface MemoryFilter {
	pinnedOnly?: boolean;
	exclude?: ReadonlySet<number>;
}

/** BM25 column weights for (title, keywords, body), in memories_fts column order. */
const BM25_WEIGHTS = "5.0, 3.0, 1.0";

/** SQL and parameters restricting `m` to the memories `scope` sees from repository `repoKey`. */
function scopeSql(context: MemoryContext, scope: ScopeFilter): { sql: string; params: string[] } {
	const { repoKey: project, workspaceId } = context;
	if (scope === "global") return { sql: "m.scope = 'global'", params: [] };
	if (scope === "workspace")
		return { sql: "m.scope = 'workspace' AND m.workspace_id = ?", params: [workspaceId ?? ""] };
	if (scope === "project") return { sql: "m.scope = 'project' AND m.repo_key = ?", params: [project] };
	return {
		sql: "(m.scope = 'global' OR (m.scope = 'project' AND m.repo_key = ?) OR (m.scope = 'workspace' AND m.workspace_id = ?))",
		params: [project, workspaceId ?? ""],
	};
}
/** `scopeSql` narrowed by `options`: only pinned memories, and none of the `exclude` ids. */
function filterSql(
	repoKey: MemoryContext,
	scope: ScopeFilter,
	options: MemoryFilter,
): { sql: string; params: string[] } {
	const where = scopeSql(repoKey, scope);
	return {
		sql: `${where.sql}${options.pinnedOnly ? " AND m.pinned = 1" : ""}${options.exclude?.size ? " AND m.id NOT IN (SELECT value FROM json_each(?))" : ""}`,
		params: [...where.params, ...(options.exclude?.size ? [JSON.stringify([...options.exclude])] : [])],
	};
}

/** A memory visible from `repoKey` (global, or project of that repository), else undefined. */
export function visible(db: DatabaseSync, repoKey: MemoryContext, id: number): Row | undefined {
	const scope = scopeSql(repoKey, "all");
	return db.prepare(`SELECT m.* FROM memories m WHERE m.id = ? AND ${scope.sql}`).get(id, ...scope.params);
}

/** Pinned first, then most recently updated. */
export function list(
	db: DatabaseSync,
	repoKey: MemoryContext,
	scope: ScopeFilter,
	limit: number,
	options: MemoryFilter,
): Row[] {
	const where = filterSql(repoKey, scope, options);
	return db
		.prepare(
			`SELECT m.* FROM memories m WHERE ${where.sql} ORDER BY m.pinned DESC, m.updated_at DESC, m.id DESC LIMIT ?`,
		)
		.all(...where.params, limit);
}

/** The `updatedAt` of each of `ids` that still exists, in one query. */
export function updatedAt(db: DatabaseSync, context: MemoryContext, ids: readonly number[]): Map<number, number> {
	const scope = scopeSql(context, "all");
	const rows = db
		.prepare(`SELECT id, updated_at FROM memories AS m WHERE id IN (SELECT value FROM json_each(?)) AND ${scope.sql}`)
		.all(JSON.stringify(ids), ...scope.params) as Row[];
	return new Map(rows.map((row) => [num(row.id), num(row.updated_at)]));
}

export function count(db: DatabaseSync, repoKey: MemoryContext, scope: ScopeFilter, options: MemoryFilter): number {
	const where = filterSql(repoKey, scope, options);
	const row = db.prepare(`SELECT count(*) AS n FROM memories m WHERE ${where.sql}`).get(...where.params) as Row;
	return num(row.n);
}

/** FTS5 matches of `match`, best first, each row carrying `bm25_score` (lower is better, negative for matches). */
export function searchFts(
	db: DatabaseSync,
	repoKey: MemoryContext,
	match: string,
	scope: ScopeFilter,
	exclude: ReadonlySet<number>,
	limit: number,
	offset = 0,
): Row[] {
	const where = scopeSql(repoKey, scope);
	return db
		.prepare(
			`SELECT m.*, bm25(memories_fts, ${BM25_WEIGHTS}) AS bm25_score FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid ` +
				`WHERE memories_fts MATCH ? AND ${where.sql} AND m.id NOT IN (SELECT value FROM json_each(?)) ORDER BY bm25_score, m.id DESC LIMIT ? OFFSET ?`,
		)
		.all(match, ...where.params, JSON.stringify([...exclude]), limit, offset);
}

/** The newest `limit` memories of `scope`, for the search that scores them in memory (no FTS5). */
export function newest(db: DatabaseSync, repoKey: MemoryContext, scope: ScopeFilter, limit: number): Row[] {
	const where = scopeSql(repoKey, scope);
	return db
		.prepare(`SELECT m.* FROM memories m WHERE ${where.sql} ORDER BY m.updated_at DESC LIMIT ?`)
		.all(...where.params, limit);
}

/**
 * Memories of `scope` that were never handed to the model or were last updated before `before`, oldest update first:
 * what `/memory review` offers to edit or delete.
 */
export function forReview(
	db: DatabaseSync,
	repoKey: MemoryContext,
	scope: ScopeFilter,
	before: number,
	limit: number,
): Row[] {
	const where = scopeSql(repoKey, scope);
	return db
		.prepare(
			`SELECT m.* FROM memories m WHERE ${where.sql} AND (m.use_count = 0 OR m.updated_at < ?) ORDER BY m.updated_at ASC, m.id ASC LIMIT ?`,
		)
		.all(...where.params, before, limit);
}

export interface NewMemory {
	scope: MemoryScope;
	repoKey: string | null;
	workspaceId: string | null;
	kind: string;
	title: string;
	body: string;
	keywords: string;
	pinned: boolean;
	author: string;
	sourceSession: string | null;
	now: number;
}

export function insert(db: DatabaseSync, memory: NewMemory): number {
	const result = db
		.prepare(
			"INSERT INTO memories (scope, repo_key, workspace_id, kind, title, body, keywords, pinned, author, source_session, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			memory.scope,
			memory.repoKey,
			memory.workspaceId,
			memory.kind,
			memory.title,
			memory.body,
			memory.keywords,
			memory.pinned ? 1 : 0,
			memory.author,
			memory.sourceSession,
			memory.now,
			memory.now,
		);
	return Number(result.lastInsertRowid);
}

/** Rewrites memory `id` (its creation time and source session stay). */
export function update(db: DatabaseSync, id: number, memory: Omit<NewMemory, "sourceSession">): void {
	db.prepare(
		"UPDATE memories SET scope = ?, repo_key = ?, workspace_id = ?, kind = ?, title = ?, body = ?, keywords = ?, pinned = ?, author = ?, updated_at = ? WHERE id = ?",
	).run(
		memory.scope,
		memory.repoKey,
		memory.workspaceId,
		memory.kind,
		memory.title,
		memory.body,
		memory.keywords,
		memory.pinned ? 1 : 0,
		memory.author,
		memory.now,
		id,
	);
}

export function remove(db: DatabaseSync, id: number): void {
	db.prepare("DELETE FROM memories WHERE id = ?").run(id);
}

/** Records that each of `ids` was handed to the model. */
export function markUsed(db: DatabaseSync, context: MemoryContext, ids: readonly number[], now: number): void {
	const scope = scopeSql(context, "all");
	db.prepare(
		`UPDATE memories AS m SET last_used = ?, use_count = use_count + 1 WHERE id IN (SELECT value FROM json_each(?)) AND ${scope.sql}`,
	).run(now, JSON.stringify(ids), ...scope.params);
}

/** Pinned first, then last edit, with id breaking ties. */
export interface MemoryCursor {
	pinned: number;
	updated: number;
	id: number;
}
export function scan(
	db: DatabaseSync,
	context: MemoryContext,
	scope: ScopeFilter,
	before: MemoryCursor,
	limit: number,
): Row[] {
	const where = scopeSql(context, scope);
	return db
		.prepare(`SELECT m.* FROM memories m WHERE ${where.sql} AND (m.pinned,m.updated_at,m.id) < (?,?,?)
		ORDER BY m.pinned DESC,m.updated_at DESC,m.id DESC LIMIT ?`)
		.all(...where.params, before.pinned, before.updated, before.id, limit);
}
