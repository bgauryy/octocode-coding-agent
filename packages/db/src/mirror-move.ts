import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MigrationContext, MigrationStore } from "./migration-context.ts";
import type { Row } from "./rows.ts";
import * as compactions from "./queries/compactions.ts";
import * as maintenance from "./queries/maintenance.ts";
import * as transcripts from "./queries/transcripts.ts";

/**
 * Schema version 10 moves the transcript mirror (`session_transcripts`, `session_entries`, `compaction_summaries`) out of
 * the coordination file into its own file (`schema-mirror.ts`). This module is the only code that knows those tables once
 * lived in the coordination file. The mirror's tables keep their names and columns, so the reads below (`inventory`,
 * `sessionDigest`) run unchanged on an old coordination file and on a mirror file, and a runner compares the two.
 *
 * The move is crash-safe and can be re-run from any point: each session is copied in its own transaction of the mirror
 * file, a session the mirror already holds identically is skipped, and the old tables are dropped only after every
 * session's copy matched its source (row counts and a SHA-256 over every column) and is on disk (the mirror's commits
 * are synced, then checkpointed), in the coordination transaction that also raises the version. A crash before that
 * commit leaves the coordination file as it was.
 */

const ENTRY_CHUNK = 500;

/** One session's stored mirror: its row counts and a SHA-256 over every column of them, in file and `seq` order. */
interface SessionDigest {
	transcripts: number;
	entries: number;
	summaries: number;
	sha256: string;
}

/** Every session's digest and the table totals; `sha256` covers every session's digest in id order. */
export interface MirrorInventory {
	transcripts: number;
	entries: number;
	summaries: number;
	sessions: Map<string, SessionDigest>;
	sha256: string;
}

const TRANSCRIPT_ROW = "SELECT file,header,byte_size,mtime,file_binding FROM session_transcripts WHERE session_id=?";
const ENTRY_ROWS =
	"SELECT position,entry_id,parent_id,type,data FROM session_entries WHERE session_id=? ORDER BY position";
const SUMMARY_ROWS = `SELECT seq,workspace_id,entry_id,summary,committed_at,origin_verified,metadata,detail_file,detail_state
	FROM compaction_summaries WHERE session_id=? ORDER BY seq`;

/** The digest of one session's mirror rows on `db`: an old coordination file or a mirror file. */
function sessionDigest(db: DatabaseSync, sessionId: string): SessionDigest {
	const hash = createHash("sha256");
	const add = (table: string, row: Row) => hash.update(`${table}\t${JSON.stringify(Object.values(row))}\n`);
	const digest = { transcripts: 0, entries: 0, summaries: 0 };
	const transcript = db.prepare(TRANSCRIPT_ROW).get(sessionId);
	if (transcript) {
		digest.transcripts = 1;
		add("t", transcript);
	}
	for (const row of db.prepare(ENTRY_ROWS).iterate(sessionId)) {
		digest.entries += 1;
		add("e", row);
	}
	for (const row of db.prepare(SUMMARY_ROWS).iterate(sessionId)) {
		digest.summaries += 1;
		add("c", row);
	}
	return { ...digest, sha256: hash.digest("hex") };
}

/** The sessions with any mirror row on `db`, in id order. */
function mirrorSessions(db: DatabaseSync): string[] {
	return db
		.prepare(`SELECT session_id FROM session_transcripts UNION SELECT session_id FROM session_entries
		UNION SELECT session_id FROM compaction_summaries ORDER BY 1`)
		.all()
		.map((row) => String(row.session_id));
}

/** Every session's digest and the totals of the mirror tables on `db` (an old coordination file or a mirror file). */
export function inventory(db: DatabaseSync): MirrorInventory {
	const sessions = new Map<string, SessionDigest>();
	const all = createHash("sha256");
	const totals = { transcripts: 0, entries: 0, summaries: 0 };
	for (const id of mirrorSessions(db)) {
		const digest = sessionDigest(db, id);
		sessions.set(id, digest);
		all.update(`${id}\t${digest.sha256}\n`);
		totals.transcripts += digest.transcripts;
		totals.entries += digest.entries;
		totals.summaries += digest.summaries;
	}
	return { ...totals, sessions, sha256: all.digest("hex") };
}

/** Copies one session's rows from the old tables into the mirror, replacing whatever the mirror held for it. */
function copySession(from: DatabaseSync, to: MigrationStore, id: string): void {
	to.transaction(() => {
		transcripts.erase(to.db, [id]);
		compactions.erase(to.db, [id]);
		const transcript = from.prepare(TRANSCRIPT_ROW).get(id);
		if (transcript) {
			const stamp = { size: Number(transcript.byte_size), mtime: String(transcript.mtime) };
			transcripts.writeStamp(to.db, id, String(transcript.file), String(transcript.header), {
				...stamp,
				binding: String(transcript.file_binding),
			});
			let chunk: { position: number; record: transcripts.EntryRow }[] = [];
			for (const row of from.prepare(ENTRY_ROWS).iterate(id)) {
				chunk.push({
					position: Number(row.position),
					record: {
						id: String(row.entry_id),
						parentId: row.parent_id === null ? null : String(row.parent_id),
						type: String(row.type),
						json: String(row.data),
					},
				});
				if (chunk.length >= ENTRY_CHUNK) {
					transcripts.insertEntries(to.db, id, chunk);
					chunk = [];
				}
			}
			transcripts.insertEntries(to.db, id, chunk);
		}
		const insert = to.db.prepare(`INSERT INTO compaction_summaries(seq,workspace_id,session_id,entry_id,summary,
			committed_at,origin_verified,metadata,detail_file,detail_state) VALUES (?,?,?,?,?,?,?,?,?,?)`);
		for (const row of from.prepare(SUMMARY_ROWS).iterate(id)) {
			const {
				seq,
				workspace_id,
				entry_id,
				summary,
				committed_at,
				origin_verified,
				metadata,
				detail_file,
				detail_state,
			} = row as Record<string, string | number | null>;
			insert.run(
				seq,
				workspace_id,
				id,
				entry_id,
				summary,
				committed_at,
				origin_verified,
				metadata,
				detail_file,
				detail_state,
			);
		}
	});
}

/** Removes the mirror's rows of sessions the old tables do not hold as they are: unknown ids, or a transcript of another file. */
function prune(from: DatabaseSync, to: MigrationStore, wanted: ReadonlySet<string>): void {
	const files = (db: DatabaseSync) =>
		new Map(
			db
				.prepare("SELECT session_id,file FROM session_transcripts")
				.all()
				.map((row) => [String(row.session_id), String(row.file)]),
		);
	const source = files(from);
	const stale = [...files(to.db)].flatMap(([id, file]) => (source.get(id) === file ? [] : [id]));
	stale.push(...mirrorSessions(to.db).filter((id) => !wanted.has(id)));
	if (stale.length === 0) return;
	to.transaction(() => {
		transcripts.erase(to.db, stale);
		compactions.erase(to.db, stale);
	});
}

/** Table totals of the mirror tables on `db`. */
function totals(db: DatabaseSync): string {
	return ["session_transcripts", "session_entries", "compaction_summaries"]
		.map((table) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n))
		.join("/");
}

/**
 * Step 10: copies every session's mirror rows into the mirror file (skipping sessions it holds identically), verifies
 * each copy and the table totals, then drops the old tables. Runs inside the coordination file's `BEGIN IMMEDIATE`, so no
 * writer of this file adds rows meanwhile; the mirror commits per session. Throws, changing nothing in the coordination
 * file, when a copy does not match.
 */
export function moveMirror(db: DatabaseSync, context: MigrationContext): void {
	// A file whose mirror tables are gone already (created without them) has nothing to move.
	if (!OLD_TABLES.every((table) => hasTable(db, table))) return dropOld(db);
	const mirror = context.openMirror();
	try {
		// The copies must outlive an OS crash before the old tables go: each commit of the move syncs the mirror's WAL.
		mirror.db.exec("PRAGMA synchronous=FULL");
		const ids = mirrorSessions(db);
		prune(db, mirror, new Set(ids));
		let done = 0;
		for (const id of ids) {
			const source = sessionDigest(db, id);
			if (sessionDigest(mirror.db, id).sha256 !== source.sha256) {
				copySession(db, mirror, id);
				if (sessionDigest(mirror.db, id).sha256 !== source.sha256)
					throw new Error(`the mirror file's copy of session ${id} does not match its source`);
			}
			context.progress?.(++done, ids.length);
		}
		if (totals(db) !== totals(mirror.db))
			throw new Error(`the mirror holds ${totals(mirror.db)} rows where the source holds ${totals(db)}`);
		// Copies an earlier, killed run left in the WAL go into the file too, synced, before the drop commits.
		maintenance.checkpoint(mirror.db);
		dropOld(db);
	} finally {
		mirror.close();
	}
}

const OLD_TABLES = ["session_entries", "session_transcripts", "compaction_summaries"] as const;

/** Children first: with foreign keys on, dropping a parent table that is still referenced deletes row by row. */
function dropOld(db: DatabaseSync): void {
	for (const table of OLD_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
}

/**
 * The backup taken before step 10 covers the coordination data only: the mirror is rebuildable from the session files
 * and its copy lives in the mirror file, so the backup keeps the old tables, empty, and is compacted.
 */
export function emptyOldMirror(copy: DatabaseSync): void {
	for (const table of OLD_TABLES) if (hasTable(copy, table)) copy.exec(`DELETE FROM ${table}`);
	copy.exec("VACUUM");
}

const hasTable = (db: DatabaseSync, name: string): boolean =>
	db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name) !== undefined;
