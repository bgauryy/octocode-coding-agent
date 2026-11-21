import type { DatabaseSync } from "node:sqlite";

/**
 * The transcript mirror's `session_transcripts` and `session_entries` (`schema-mirror.ts`). Every function takes the
 * mirror's connection (`AgentDb.mirror.db`), never the coordination one: the session and workspace a transcript belongs
 * to are rows of the coordination file (`sessions.ts`), read there.
 */

interface TranscriptStamp {
	file: string;
	byte_size: number;
	mtime: string;
	file_binding: string;
}

/** The saved stamp of a transcript; `file_binding` is `ino:birth`. */
export function stamp(db: DatabaseSync, sessionId: string): TranscriptStamp | undefined {
	return db
		.prepare("SELECT file,byte_size,mtime,file_binding FROM session_transcripts WHERE session_id=?")
		.get(sessionId) as TranscriptStamp | undefined;
}

/** The session whose transcript is this exact path, including transcripts stored outside its checkout. */
export function fileOwner(db: DatabaseSync, file: string): string | undefined {
	const row = db.prepare("SELECT session_id FROM session_transcripts WHERE file=?").get(file);
	return row ? String(row.session_id) : undefined;
}

/** The ids of a transcript's stored entries of `type`, in file order. */
export function entryIds(db: DatabaseSync, sessionId: string, type: string): string[] {
	return db
		.prepare("SELECT entry_id FROM session_entries WHERE session_id=? AND type=? ORDER BY position")
		.all(sessionId, type)
		.map((row) => String(row.entry_id));
}

/** Whether a transcript of `sessionId` is stored. */
export function has(db: DatabaseSync, sessionId: string): boolean {
	return db.prepare("SELECT 1 FROM session_transcripts WHERE session_id=?").get(sessionId) !== undefined;
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

/**
 * Where the stored transcript ends, read from one snapshot: its stamp, header, how many entries are stored (0 when the
 * range has a gap) and the last of them as stored (the line the file holds). A process that opens the file checks that
 * line against the file's bytes before the stamp's size, then sends only the lines after it.
 */
export function storedEnd(
	db: DatabaseSync,
	sessionId: string,
): { stamp: TranscriptStamp | undefined; header: string | undefined; stored: number; last: EntryRow | undefined } {
	const own = !db.isTransaction;
	if (own) db.exec("BEGIN");
	try {
		const saved = stamp(db, sessionId);
		const range = storedRange(db, sessionId);
		if (!saved || range.n === 0 || range.last !== range.n - 1)
			return { stamp: saved, header: undefined, stored: 0, last: undefined };
		const header = db.prepare("SELECT header FROM session_transcripts WHERE session_id=?").get(sessionId);
		const last = db
			.prepare("SELECT entry_id,parent_id,type,data FROM session_entries WHERE session_id=? AND position=?")
			.get(sessionId, range.last);
		return {
			stamp: saved,
			header: header ? String(header.header) : undefined,
			stored: range.n,
			last: last && {
				id: String(last.entry_id),
				parentId: last.parent_id === null ? null : String(last.parent_id),
				type: String(last.type),
				json: String(last.data),
			},
		};
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

/** Rows `erase` and `expire` removed: transcripts and their entries. */
export interface RemovedTranscripts {
	transcripts: number;
	entries: number;
}

/** Removes the stored transcripts of `ids` with their entries (a user's deletion of those sessions). */
export function erase(db: DatabaseSync, ids: readonly string[]): RemovedTranscripts {
	const json = JSON.stringify([...new Set(ids)]);
	return {
		entries: Number(
			db.prepare("DELETE FROM session_entries WHERE session_id IN (SELECT value FROM json_each(?))").run(json).changes,
		),
		transcripts: Number(
			db.prepare("DELETE FROM session_transcripts WHERE session_id IN (SELECT value FROM json_each(?))").run(json)
				.changes,
		),
	};
}

/**
 * Removes the stored transcripts of `ids` whose last save, `mtime` (the file's modification time, ns, at that save), is
 * before `before` (ms since epoch), with their entries: the age rule for sessions whose file is gone (`expire.orphans`).
 */
export function expire(db: DatabaseSync, ids: readonly string[], before: number): RemovedTranscripts {
	const json = JSON.stringify([...new Set(ids)]);
	const stale = `session_id IN (SELECT value FROM json_each(?1)) AND mtime GLOB '[0-9]*' AND CAST(mtime AS INTEGER) / 1000000 < ?2`;
	return {
		entries: Number(
			db
				.prepare(
					`DELETE FROM session_entries WHERE session_id IN (SELECT session_id FROM session_transcripts WHERE ${stale})`,
				)
				.run(json, before).changes,
		),
		transcripts: Number(db.prepare(`DELETE FROM session_transcripts WHERE ${stale}`).run(json, before).changes),
	};
}

/** Removes every stored transcript except those of the sessions in `kept` (`purge.all`). */
export function keepOnly(db: DatabaseSync, kept: readonly string[]): RemovedTranscripts {
	const json = JSON.stringify([...new Set(kept)]);
	const outside = "session_id NOT IN (SELECT value FROM json_each(?))";
	return {
		entries: Number(db.prepare(`DELETE FROM session_entries WHERE ${outside}`).run(json).changes),
		transcripts: Number(db.prepare(`DELETE FROM session_transcripts WHERE ${outside}`).run(json).changes),
	};
}
