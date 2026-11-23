/**
 * `provider_quota` (`queries/provider-quota.ts`): the latest quota reading per provider and window, as response
 * headers or a CLI's stream event reported it (`used` is the fraction used, 0 to 1). Every Octocode process on the
 * machine writes and reads it, since they share one credential per provider. One row per provider and window, replaced
 * by a newer reading, so the table holds only the windows in use. Created with IF NOT EXISTS like the other ensured
 * objects (`COORDINATION_FILE.ensure`). Apart from `provider_cooldowns`: these rows are wider, several per provider, and
 * read by the interface rather than at each request start. WITHOUT ROWID: the reads are a primary-key range or a scan
 * of a few rows.
 */
export const PROVIDER_QUOTA_SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_quota (
  provider TEXT NOT NULL, window TEXT NOT NULL, label TEXT NOT NULL, used REAL NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('plan','rate')), resets_at INTEGER,
  source TEXT NOT NULL CHECK(source IN ('header','event','error')), updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, window)) WITHOUT ROWID;
`;
