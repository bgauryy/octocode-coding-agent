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

/** Only the host operation which creates a fork supplies this edge. An imported JSONL header cannot grant archive access. */
export function linkFork(db: DatabaseSync, child: string, file: string, parent: string): void {
	const result = db
		.prepare(`INSERT INTO session_forks(child_id,child_file,parent_id) SELECT ?,?,?
		WHERE NOT EXISTS(SELECT 1 FROM session_transcripts WHERE session_id=? AND file<>?)`)
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

interface EntryRecord {
	id: string;
	parentId: string | null;
	type: string;
}

export function save(
	db: DatabaseSync,
	sessionId: string,
	file: string,
	header: object,
	stamp: { size: number; mtime: string; binding: string },
	entries: readonly EntryRecord[],
	start: number,
	previousFile?: string,
): void {
	const result = db
		.prepare(`INSERT INTO session_transcripts(session_id,file,header,byte_size,mtime,file_binding) VALUES (?,?,?,?,?,?)
		ON CONFLICT(session_id) DO UPDATE SET file=excluded.file,header=excluded.header,
		byte_size=excluded.byte_size,mtime=excluded.mtime,file_binding=excluded.file_binding WHERE session_transcripts.file=?`)
		.run(sessionId, file, JSON.stringify(header), stamp.size, stamp.mtime, stamp.binding, previousFile ?? null);
	if (!result.changes) throw new Error("Another transcript claimed this session ID");
	if (start === 0) db.prepare("DELETE FROM session_entries WHERE session_id=?").run(sessionId);
	const insert = db.prepare(
		"INSERT INTO session_entries(session_id,position,entry_id,parent_id,type,data) VALUES (?,?,?,?,?,?)",
	);
	for (const [offset, entry] of entries.entries()) {
		insert.run(sessionId, start + offset, entry.id, entry.parentId ?? null, entry.type, JSON.stringify(entry));
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

/** Explicit transcript deletion (the workspace catalog and independently retained summaries survive it). */
export function removeFile(db: DatabaseSync, file: string, sessionId: string): void {
	db.prepare("DELETE FROM session_transcripts WHERE file=? AND session_id=?").run(file, sessionId);
}
