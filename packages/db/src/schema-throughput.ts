/**
 * `provider_throughput_reservations` and `provider_throughput_state` (`queries/provider-throughput.ts`): the shared
 * one-minute token and request reservations per model and Region key, and the adaptive capacity scale each key
 * carries. Every Octocode process on the machine shares one provider quota, so the rows live in the coordination file.
 * A reservation keeps its estimate and, once the response is known, the actual token count; its row also counts as one
 * request. Created with IF NOT EXISTS like the other ensured objects.
 */
export const PROVIDER_THROUGHPUT_SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_throughput_reservations (
  key TEXT NOT NULL, window_start INTEGER NOT NULL, reservation_id TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL CHECK(estimated_tokens >= 0),
  actual_tokens INTEGER CHECK(actual_tokens IS NULL OR actual_tokens >= 0), created_at INTEGER NOT NULL,
  PRIMARY KEY (key, window_start, reservation_id));
CREATE INDEX IF NOT EXISTS provider_throughput_reservations_window ON provider_throughput_reservations(window_start);
CREATE TABLE IF NOT EXISTS provider_throughput_state (
  key TEXT PRIMARY KEY, scale REAL NOT NULL, successes INTEGER NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID;
`;
