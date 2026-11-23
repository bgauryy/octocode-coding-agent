import type { DatabaseSync } from "node:sqlite";

/**
 * The archive search index (`archive-index.db`): a disposable cache of archive files cut into passages, each passage's
 * terms in a contentless FTS5 table. The caller tokenizes; terms are stored as they are (the `ascii` tokenizer with
 * `._-/` as token characters keeps each one whole), so the index counts exactly what a scan counts. A file is re-indexed
 * when its size, mtime or inode moves. Without FTS5 the file holds no passages and callers scan instead.
 */

/** "OcIX": the header id of the index file. */
export const APPLICATION_ID = 0x4f634958;

const TABLES = `
CREATE TABLE files(id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL,
	ino INTEGER NOT NULL, passages INTEGER NOT NULL, words INTEGER NOT NULL);
CREATE TABLE passages(id INTEGER PRIMARY KEY, file INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
	length INTEGER NOT NULL, byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL, context TEXT);
CREATE INDEX passages_file ON passages(file);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
`;

const FTS = `
CREATE VIRTUAL TABLE passages_fts USING fts5(body, content='', contentless_delete=1, tokenize="ascii tokenchars '._-/'");
CREATE VIRTUAL TABLE passages_terms USING fts5vocab(passages_fts, instance);
`;

/** Creates the schema in an empty file; returns whether FTS5 was available. */
export function create(db: DatabaseSync): { fts: boolean } {
	db.exec(TABLES);
	try {
		db.exec(FTS);
		return { fts: true };
	} catch (error) {
		if (!(error instanceof Error && /no such module: fts5/i.test(error.message))) throw error;
		return { fts: false };
	}
}

/** Whether this file has its full-text tables (it was created where SQLite had FTS5 and they are still there). */
export function hasFts(db: DatabaseSync): boolean {
	return Boolean(
		db
			.prepare(
				"SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='passages_fts') AND EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='passages_terms') AS fts",
			)
			.get()?.fts,
	);
}

export function readMeta(db: DatabaseSync, key: string): string | undefined {
	return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function writeMeta(db: DatabaseSync, key: string, value: string): void {
	db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
		key,
		value,
	);
}

/** Removes every file and passage (a tokenizer change makes them all stale). */
export function clear(db: DatabaseSync): void {
	db.exec("DELETE FROM files; DELETE FROM passages; INSERT INTO passages_fts(passages_fts) VALUES ('delete-all');");
}

export interface IndexedFile {
	id: number;
	path: string;
	size: number;
	mtime: number;
	ino: number;
	passages: number;
	words: number;
}

/** Every indexed file with the stamp it was indexed at and its totals. */
export function files(db: DatabaseSync): IndexedFile[] {
	return db.prepare("SELECT id, path, size, mtime, ino, passages, words FROM files").all() as unknown as IndexedFile[];
}

export interface PassageRow {
	start: number;
	end: number;
	length: number;
	byteStart: number;
	byteEnd: number;
	/** JSON, or null when the passage reads the same on its own. */
	context: string | null;
	/** Its terms in order, space-separated. */
	body: string;
}

function removeFile(db: DatabaseSync, id: number): void {
	db.prepare("DELETE FROM passages_fts WHERE rowid IN (SELECT id FROM passages WHERE file = ?)").run(id);
	db.prepare("DELETE FROM passages WHERE file = ?").run(id);
	db.prepare("DELETE FROM files WHERE id = ?").run(id);
}

/** Removes the files `paths` and their passages. */
export function deleteFiles(db: DatabaseSync, paths: readonly string[]): void {
	const find = db.prepare("SELECT id FROM files WHERE path = ?");
	for (const file of paths) {
		const row = find.get(file) as { id: number } | undefined;
		if (row) removeFile(db, row.id);
	}
}

/** Stores `file` at its stamp with its `passages`, replacing what was stored for that path; returns its row. */
export function replaceFile(
	db: DatabaseSync,
	file: { path: string; size: number; mtime: number; ino: number },
	passages: readonly PassageRow[],
): IndexedFile {
	deleteFiles(db, [file.path]);
	const words = passages.reduce((sum, passage) => sum + passage.length, 0);
	const { lastInsertRowid } = db
		.prepare("INSERT INTO files(path, size, mtime, ino, passages, words) VALUES (?, ?, ?, ?, ?, ?)")
		.run(file.path, file.size, file.mtime, file.ino, passages.length, words);
	const passage = db.prepare(
		"INSERT INTO passages(file, start, end, length, byte_start, byte_end, context) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const body = db.prepare("INSERT INTO passages_fts(rowid, body) VALUES (?, ?)");
	for (const row of passages) {
		const id = passage.run(
			lastInsertRowid,
			row.start,
			row.end,
			row.length,
			row.byteStart,
			row.byteEnd,
			row.context,
		).lastInsertRowid;
		body.run(id, row.body);
	}
	return { id: Number(lastInsertRowid), ...file, passages: passages.length, words };
}

/**
 * One term in one passage: `[passage id, file id, term, count, start line, end line, length]`. A tuple, since a common
 * query term yields tens of thousands of rows and objects cost twice the time to build.
 */
export type TermCount = [
	passage: number,
	file: number,
	term: string,
	count: number,
	start: number,
	end: number,
	length: number,
];

/**
 * How often each of `terms` occurs in each passage of the files `fileIds` holding it, with what scoring needs of the
 * passage. The files are one JSON array parameter, so a long list is no limit; no files or no terms read nothing.
 */
export function termCounts(db: DatabaseSync, terms: readonly string[], fileIds: readonly number[]): TermCount[] {
	if (terms.length === 0 || fileIds.length === 0) return [];
	const statement = db.prepare(
		`SELECT v.doc, p.file, v.term, count(*), p.start, p.end, p.length
		FROM passages_terms v JOIN passages p ON p.id = v.doc
		WHERE v.term IN (${terms.map(() => "?").join(", ")})
			AND p.file IN (SELECT value FROM json_each(?))
		GROUP BY v.doc, v.term`,
	);
	statement.setReturnArrays(true);
	return statement.all(...terms, JSON.stringify(fileIds)) as unknown as TermCount[];
}

export interface PassageRange {
	id: number;
	byteStart: number;
	byteEnd: number;
	/** JSON, or null when the passage reads the same on its own. */
	context: string | null;
}

/** The byte range and reading context of each passage of `ids` still stored. */
export function passageRanges(db: DatabaseSync, ids: readonly number[]): PassageRange[] {
	if (ids.length === 0) return [];
	return db
		.prepare(
			`SELECT id, byte_start AS byteStart, byte_end AS byteEnd, context FROM passages
			WHERE id IN (SELECT value FROM json_each(?))`,
		)
		.all(JSON.stringify(ids)) as unknown as PassageRange[];
}

/** Merges the full-text index's segments; worth it after a large build. */
export function optimize(db: DatabaseSync): void {
	db.exec("INSERT INTO passages_fts(passages_fts) VALUES ('optimize')");
}
