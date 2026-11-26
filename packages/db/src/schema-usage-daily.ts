/**
 * `usage_daily` (`queries/usage-daily.ts`): model spend added up per local day, workspace, provider, model, kind of
 * request (`reply`, `compaction_attempt`, `cache_warm`…) and billing (`plan`: a subscription paid, so `cost` is an
 * estimate at list price; `metered`: `cost` is money). One upsert per recorded request, so `/usage` reads a few hundred
 * rows for any range; history starts when this table was created. Created with IF NOT EXISTS like the other ensured
 * objects (added by the version-10 upgrade, `schema-migrations.ts`). WITHOUT ROWID: every write and every range read goes through the primary key,
 * whose first column is the day.
 */
export const USAGE_DAILY_SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL, workspace_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL,
  billing TEXT NOT NULL CHECK(billing IN ('plan','metered')),
  requests INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL, cost REAL NOT NULL, unpriced INTEGER NOT NULL,
  PRIMARY KEY(day, workspace_id, provider, model, kind, billing)) WITHOUT ROWID;
`;
