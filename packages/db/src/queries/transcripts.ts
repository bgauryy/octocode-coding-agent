import type { DatabaseSync } from "node:sqlite";
import { bindingKey } from "../binding.ts";

export const TRANSCRIPTS_SCHEMA = `
CREATE TABLE session_transcripts (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file TEXT NOT NULL UNIQUE, header TEXT NOT NULL, byte_size INTEGER NOT NULL, mtime TEXT NOT NULL, file_binding TEXT NOT NULL);
CREATE TABLE session_forks (
  child_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  child_file TEXT NOT NULL, CHECK(child_id <> parent_id));
CREATE INDEX session_forks_parent ON session_forks(parent_id);
CREATE TABLE session_entries (
  session_id TEXT NOT NULL REFERENCES session_transcripts(session_id) ON DELETE CASCADE,
  position INTEGER NOT NULL, entry_id TEXT NOT NULL, parent_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(session_id, position));
CREATE INDEX session_entries_tree ON session_entries(session_id, parent_id);
CREATE INDEX session_entries_id ON session_entries(session_id, entry_id);
`;

interface TranscriptStamp {
	file: string;
	byte_size: number;
	mtime: string;
	file_binding: string;
	workspace_id: string | null;
}

/** The saved stamp of a transcript; `file_binding` is `ino:birth` whatever format the row stores (see `binding.ts`). */
export function stamp(db: DatabaseSync, sessionId: string): TranscriptStamp | undefined {
	const row = db
		.prepare(`SELECT t.file,t.byte_size,t.mtime,t.file_binding,s.workspace_id FROM session_transcripts t
		JOIN sessions s ON s.id=t.session_id WHERE t.session_id=?`)
		.get(sessionId) as TranscriptStamp | undefined;
	return row && { ...row, file_binding: bindingKey(row.file_binding) };
}

/** Which workspace has indexed this exact transcript path, including transcripts stored outside its checkout. */
export function fileOwner(db: DatabaseSync, file: string): { id: string; workspace_id: string | null } | undefined {
	return db
		.prepare(`SELECT s.id,s.workspace_id FROM session_transcripts t JOIN sessions s ON t.session_id=s.id
		WHERE t.file=?`)
		.get(file) as { id: string; workspace_id: string | null } | undefined;
}

/** Bind once. A copied file with an existing ID cannot replace another workspace's history. */
export function bind(db: DatabaseSync, id: string, workspaceId: string | null): void {
	const result = db
		.prepare(`INSERT INTO sessions(id,workspace_id) VALUES (?,?)
		ON CONFLICT(id) DO UPDATE SET workspace_id=COALESCE(sessions.workspace_id,excluded.workspace_id)
		WHERE sessions.workspace_id IS NULL OR excluded.workspace_id IS NULL OR sessions.workspace_id=excluded.workspace_id`)
		.run(id, workspaceId);
	if (!result.changes) throw new Error("Session ID is already bound to another workspace");
}

/**
 * Only the host operation which creates a fork supplies this edge. An imported JSONL header cannot grant archive access.
 * Recording the same edge again (a retry whose first commit lost its acknowledgement) succeeds; a different edge for the
 * child is refused.
 */
export function linkFork(db: DatabaseSync, child: string, file: string, parent: string): void {
	const result = db
		.prepare(`INSERT INTO session_forks(child_id,child_file,parent_id) SELECT ?,?,?
		WHERE NOT EXISTS(SELECT 1 FROM session_transcripts WHERE session_id=? AND file<>?)
		ON CONFLICT(child_id) DO UPDATE SET child_file=excluded.child_file
		WHERE session_forks.child_file=excluded.child_file AND session_forks.parent_id=excluded.parent_id`)
		.run(child, file, parent, child, file);
	if (!result.changes) throw new Error("Another transcript already uses this session ID");
}

/** A materialized fork inherited these compaction entries from its saved parent snapshot. */
export function inheritedCompactions(db: DatabaseSync, child: string): Set<string> | undefined {
	const rows = db
		.prepare(`SELECT e.entry_id FROM session_forks f LEFT JOIN session_entries e
		ON e.session_id=f.parent_id AND e.type='compaction' WHERE f.child_id=?`)
		.all(child);
	return rows.length
		? new Set(rows.flatMap((row) => (typeof row.entry_id === "string" ? [row.entry_id] : [])))
		: undefined;
}

/** Follow recorded edges, anchoring the first one to the same checkout and transcript file that the host actually opened. */
export function lineage(db: DatabaseSync, child: string, file: string, workspace: string): string[] {
	return db
		.prepare(`WITH RECURSIVE parents(id,depth) AS (
		SELECT f.parent_id,1 FROM session_forks f JOIN sessions s ON s.id=f.child_id
		LEFT JOIN session_transcripts t ON t.session_id=f.child_id
		WHERE f.child_id=? AND COALESCE(t.file,f.child_file)=? AND s.workspace_id=?
		UNION ALL SELECT f.parent_id,p.depth+1 FROM parents p JOIN session_forks f ON f.child_id=p.id WHERE p.depth<32)
		SELECT id FROM parents ORDER BY depth`)
		.all(child, file, workspace)
		.map((row) => String(row.id));
}

/**
 * One transcript record as the session file holds it: `json` is its line without the newline, serialized by the writer
 * of the file, and stored as is so the copy is byte-identical to the file.
 */
export interface EntryRow {
	id: string;
	parentId: string | null;
	type: string;
	json: string;
}

/** The transcript's file stamp as `save` takes it: `mtime` is compared as text only, never parsed. */
interface SavedStamp {
	size: number;
	mtime: string;
	binding: string;
}

/**
 * Write the transcript row: its file, header (JSON text) and stamp. `previousFile` is the file the row must still name
 * when it exists; another file there throws (another transcript claimed the session ID).
 */
export function writeStamp(
	db: DatabaseSync,
	sessionId: string,
	file: string,
	header: string,
	stamp: SavedStamp,
	previousFile?: string,
): void {
	const result = db
		.prepare(`INSERT INTO session_transcripts(session_id,file,header,byte_size,mtime,file_binding) VALUES (?,?,?,?,?,?)
		ON CONFLICT(session_id) DO UPDATE SET file=excluded.file,header=excluded.header,
		byte_size=excluded.byte_size,mtime=excluded.mtime,file_binding=excluded.file_binding WHERE session_transcripts.file=?`)
		.run(sessionId, file, header, stamp.size, stamp.mtime, stamp.binding, previousFile ?? null);
	if (!result.changes) throw new Error("Another transcript claimed this session ID");
}

/** Insert entries at their positions (one prepared statement for the batch). */
export function insertEntries(
	db: DatabaseSync,
	sessionId: string,
	rows: readonly { position: number; record: EntryRow }[],
): void {
	if (rows.length === 0) return;
	const insert = db.prepare(
		"INSERT INTO session_entries(session_id,position,entry_id,parent_id,type,data) VALUES (?,?,?,?,?,?)",
	);
	for (const { position, record } of rows)
		insert.run(sessionId, position, record.id, record.parentId ?? null, record.type, record.json);
}

/** Delete the stored entries from position `from` on. */
export function deleteEntriesFrom(db: DatabaseSync, sessionId: string, from: number): void {
	db.prepare("DELETE FROM session_entries WHERE session_id=? AND position>=?").run(sessionId, from);
}

/**
 * Save the header (its JSON text) and `entries` from position `start`; `start` 0 replaces every stored entry. A test
 * fixture: the host stores transcripts through the writer's commands (`writer/transcript-mirror.ts`,
 * `writer/transcript-save.ts`), which call `writeStamp`, `deleteEntriesFrom` and `insertEntries` in steps. Tests use it
 * to seed a stored transcript in one call.
 */
export function save(
	db: DatabaseSync,
	sessionId: string,
	file: string,
	header: string,
	stamp: SavedStamp,
	entries: readonly EntryRow[],
	start: number,
	previousFile?: string,
): void {
	writeStamp(db, sessionId, file, header, stamp, previousFile);
	if (start === 0) deleteEntriesFrom(db, sessionId, 0);
	insertEntries(
		db,
		sessionId,
		entries.map((record, offset) => ({ position: start + offset, record })),
	);
}

/**
 * The transcript's stamp, how many entries are stored (`stored`, positions `0..stored-1`), and how many of the first
 * of them hold exactly `lines` (`common`), read from one snapshot. It stops reading at the first difference. A stored
 * range with a gap counts as sharing nothing. Run it outside a write transaction: it waits for no lock.
 */
export function storedPrefix(
	db: DatabaseSync,
	sessionId: string,
	lines: readonly string[],
): { stamp: TranscriptStamp | undefined; stored: number; common: number } {
	const own = !db.isTransaction;
	if (own) db.exec("BEGIN");
	try {
		const saved = stamp(db, sessionId);
		const range = storedRange(db, sessionId);
		const stored = range.n;
		if (!saved || stored === 0 || range.last !== stored - 1) return { stamp: saved, stored, common: 0 };
		let common = 0;
		for (const data of entries(db, sessionId)) {
			if (common >= lines.length || data !== lines[common]) break;
			common += 1;
		}
		return { stamp: saved, stored, common };
	} finally {
		if (own) db.exec("COMMIT");
	}
}

/** How many entries a transcript stores, the highest position and the id of the entry there. */
function storedRange(db: DatabaseSync, sessionId: string): { n: number; last: number | null; lastId: string | null } {
	return db
		.prepare(`SELECT COUNT(*) AS n, MAX(position) AS last,
		(SELECT entry_id FROM session_entries WHERE session_id=?1 ORDER BY position DESC LIMIT 1) AS lastId
		FROM session_entries WHERE session_id=?1`)
		.get(sessionId) as { n: number; last: number | null; lastId: string | null };
}

/**
 * The transcript's stamp, how many entries are stored (positions `0..stored-1`; 0 when the range has a gap) and the id
 * of the last of them, read from one snapshot: where a writer that holds the same file can continue the mirror.
 */
export function storedTail(
	db: DatabaseSync,
	sessionId: string,
): { stamp: TranscriptStamp | undefined; stored: number; lastId: string | undefined } {
	const own = !db.isTransaction;
	if (own) db.exec("BEGIN");
	try {
		const saved = stamp(db, sessionId);
		const range = storedRange(db, sessionId);
		const whole = range.n > 0 && range.last === range.n - 1;
		return { stamp: saved, stored: whole ? range.n : 0, lastId: whole ? (range.lastId ?? undefined) : undefined };
	} finally {
		if (own) db.exec("COMMIT");
	}
}

/** Reconstruct the durable transcript in JSONL order, including branches, tool results and compactions. */
export function records(db: DatabaseSync, sessionId: string): string[] {
	return db
		.prepare(`SELECT header AS data,-1 AS position FROM session_transcripts WHERE session_id=?
		UNION ALL SELECT data,position FROM session_entries WHERE session_id=? ORDER BY position`)
		.all(sessionId, sessionId)
		.map((row) => String(row.data));
}

/** Stream a transcript in branch-file order without loading all of its entries at once. */
export function* entries(db: DatabaseSync, sessionId: string): Generator<string> {
	const rows = db.prepare("SELECT data FROM session_entries WHERE session_id=? ORDER BY position").iterate(sessionId);
	for (const row of rows) yield String(row.data);
}

/** The header of every stored transcript: an offline report over all sessions reads each session's start and directory here. */
export function headers(db: DatabaseSync): Array<{ sessionId: string; header: string }> {
	return db
		.prepare("SELECT session_id, header FROM session_transcripts ORDER BY session_id")
		.all()
		.map((row) => ({ sessionId: String(row.session_id), header: String(row.header) }));
}

/** Stream the entries of `types` of every session, each session's in file order: a read-only scan for offline reports. */
export function* scan(db: DatabaseSync, types: readonly string[]): Generator<{ sessionId: string; data: string }> {
	const rows = db
		.prepare(`SELECT session_id, data FROM session_entries WHERE type IN (SELECT value FROM json_each(?))
		ORDER BY session_id, position`)
		.iterate(JSON.stringify(types));
	for (const row of rows) yield { sessionId: String(row.session_id), data: String(row.data) };
}

/** Explicit transcript deletion (the workspace catalog and independently retained summaries survive it). */
export function removeFile(db: DatabaseSync, file: string, sessionId: string): void {
	db.prepare("DELETE FROM session_transcripts WHERE file=? AND session_id=?").run(file, sessionId);
}
