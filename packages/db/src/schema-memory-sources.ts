/**
 * `memory_sources` (`queries/memory-sources.ts`): where a note came from. One row per note revision (`revision` is the
 * note's `updated_at`) and source anchor; `anchor` is the text form of a `SourceAnchor`. A row is `pending` from the
 * note's save until its MEMORY.md write finishes, then `final`. Separate from the loaded-payload ledger: both only share
 * the anchor locator. Created with IF NOT EXISTS like the other ensured objects; rows go with their note.
 */
export const MEMORY_SOURCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_sources (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
  anchor TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','final')), created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, revision, anchor));
CREATE INDEX IF NOT EXISTS memory_sources_pending ON memory_sources(state) WHERE state = 'pending';
`;
