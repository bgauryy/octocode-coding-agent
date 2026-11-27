import type { DatabaseSync } from "node:sqlite";

/** `PRAGMA application_id` of a transcript mirror file ("OcTX"): neither a coordination file nor any other SQLite file. */
export const MIRROR_APPLICATION_ID = 0x4f635458;

/**
 * The transcript mirror (`transcripts.db`, its own file beside the coordination database): a derived, rebuildable index
 * of the JSONL session files, which stay the record. `session_transcripts` holds each file's header line and stamp,
 * `session_entries` its records in file order (`queries/transcripts.ts`), `compaction_summaries` the summaries of its
 * compactions with their detail-file state (`queries/compactions.ts`). Session and workspace ids name rows of the
 * coordination file; no foreign key can cross files, so deleting a session removes its rows here in code
 * (`sessions.erase`, `purge`, `expire`).
 */
const MIRROR_SCHEMA = `
CREATE TABLE session_transcripts (
  session_id TEXT PRIMARY KEY NOT NULL,
  file TEXT NOT NULL UNIQUE, header TEXT NOT NULL, byte_size INTEGER NOT NULL, mtime TEXT NOT NULL, file_binding TEXT NOT NULL);
CREATE TABLE session_entries (
  session_id TEXT NOT NULL REFERENCES session_transcripts(session_id) ON DELETE CASCADE,
  position INTEGER NOT NULL, entry_id TEXT NOT NULL, parent_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(session_id, position));
CREATE INDEX session_entries_tree ON session_entries(session_id, parent_id);
CREATE INDEX session_entries_id ON session_entries(session_id, entry_id);
CREATE TABLE compaction_summaries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, entry_id TEXT NOT NULL,
  summary TEXT NOT NULL, committed_at INTEGER, origin_verified INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}', detail_file TEXT, detail_state TEXT NOT NULL DEFAULT 'missing',
  UNIQUE(session_id, entry_id));
CREATE INDEX compaction_summaries_workspace ON compaction_summaries(workspace_id, seq DESC);
`;

/** Creates the mirror's newest schema in an empty file. It has no full-text index. */
export function createMirrorSchema(db: DatabaseSync): { fts: boolean } {
	db.exec(MIRROR_SCHEMA);
	return { fts: false };
}
