import type { DatabaseSync } from "node:sqlite";
import { num, type Row } from "../rows.ts";

export type MemoryScope = "global" | "project";
/** Which memories a read sees: `all` is global plus this repository's project memories. */
export type ScopeFilter = MemoryScope | "all";
/** Narrows a list or count: only pinned memories, and none of the `exclude` ids (those already in context). */
export interface MemoryFilter {
	pinnedOnly?: boolean;
	exclude?: ReadonlySet<number>;
}

/** BM25 column weights for (title, keywords, body), in memories_fts column order. */
const BM25_WEIGHTS = "5.0, 3.0, 1.0";

/** SQL and parameters restricting `m` to the memories `scope` sees from repository `repoKey`. */
function scopeSql(repoKey: string, scope: ScopeFilter): { sql: string; params: string[] } {
	if (scope === "global") return { sql: "m.scope = 'global'", params: [] };
	if (scope === "project") return { sql: "m.scope = 'project' AND m.repo_key = ?", params: [repoKey] };
	return { sql: "(m.scope = 'global' OR (m.scope = 'project' AND m.repo_key = ?))", params: [repoKey] };
}

/** `scopeSql` narrowed by `options`: only pinned memories, and none of the `exclude` ids. */
function filterSql(repoKey: string, scope: ScopeFilter, options: MemoryFilter): { sql: string; params: string[] } {
	const where = scopeSql(repoKey, scope);
	return {
		sql: `${where.sql}${options.pinnedOnly ? " AND m.pinned = 1" : ""}${options.exclude?.size ? " AND m.id NOT IN (SELECT value FROM json_each(?))" : ""}`,
		params: [...where.params, ...(options.exclude?.size ? [JSON.stringify([...options.exclude])] : [])],
	};
}

/** A memory visible from `repoKey` (global, or project of that repository), else undefined. */
export function visible(db: DatabaseSync, repoKey: string, id: number): Row | undefined {
	const scope = scopeSql(repoKey, "all");
	return db.prepare(`SELECT m.* FROM memories m WHERE m.id = ? AND ${scope.sql}`).get(id, ...scope.params);
}

/** Pinned first, then most recently updated. */
export function list(
	db: DatabaseSync,
	repoKey: string,
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
export function updatedAt(db: DatabaseSync, ids: readonly number[]): Map<number, number> {
	const rows = db
		.prepare("SELECT id, updated_at FROM memories WHERE id IN (SELECT value FROM json_each(?))")
		.all(JSON.stringify(ids)) as Row[];
	return new Map(rows.map((row) => [num(row.id), num(row.updated_at)]));
}

export function count(db: DatabaseSync, repoKey: string, scope: ScopeFilter, options: MemoryFilter): number {
	const where = filterSql(repoKey, scope, options);
	const row = db.prepare(`SELECT count(*) AS n FROM memories m WHERE ${where.sql}`).get(...where.params) as Row;
	return num(row.n);
}

/** FTS5 matches of `match`, best first, each row carrying `bm25_score` (lower is better, negative for matches). */
export function searchFts(
	db: DatabaseSync,
	repoKey: string,
	match: string,
	scope: ScopeFilter,
	exclude: ReadonlySet<number>,
	limit: number,
): Row[] {
	const where = scopeSql(repoKey, scope);
	return db
		.prepare(
			`SELECT m.*, bm25(memories_fts, ${BM25_WEIGHTS}) AS bm25_score FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid ` +
				`WHERE memories_fts MATCH ? AND ${where.sql} AND m.id NOT IN (SELECT value FROM json_each(?)) ORDER BY bm25_score LIMIT ?`,
		)
		.all(match, ...where.params, JSON.stringify([...exclude]), limit);
}

/** The newest `limit` memories of `scope`, for the search that scores them in memory (no FTS5). */
export function newest(db: DatabaseSync, repoKey: string, scope: ScopeFilter, limit: number): Row[] {
	const where = scopeSql(repoKey, scope);
	return db
		.prepare(`SELECT m.* FROM memories m WHERE ${where.sql} ORDER BY m.updated_at DESC LIMIT ?`)
		.all(...where.params, limit);
}

export interface NewMemory {
	scope: string;
	repoKey: string | null;
	kind: string;
	title: string;
	body: string;
	keywords: string;
	pinned: boolean;
	author: string;
	sourceSession: string | null;
	now: number;
}

/** Inserts a memory and returns its id. */
export function insert(db: DatabaseSync, memory: NewMemory): number {
	const result = db
		.prepare(
			"INSERT INTO memories (scope, repo_key, kind, title, body, keywords, pinned, author, source_session, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			memory.scope,
			memory.repoKey,
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
		"UPDATE memories SET scope = ?, repo_key = ?, kind = ?, title = ?, body = ?, keywords = ?, pinned = ?, author = ?, updated_at = ? WHERE id = ?",
	).run(
		memory.scope,
		memory.repoKey,
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
export function markUsed(db: DatabaseSync, ids: readonly number[], now: number): void {
	const statement = db.prepare("UPDATE memories SET last_used = ?, use_count = use_count + 1 WHERE id = ?");
	for (const id of ids) statement.run(now, id);
}
