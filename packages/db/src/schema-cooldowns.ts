/**
 * `provider_cooldowns` (`queries/provider-cooldowns.ts`): when each model provider may next be sent a request after a
 * rate limit, shared by every Octocode process on the machine (sessions, their subagents, peers in other terminals), since
 * they all use the same key. One row per provider, replaced on each record, so the table holds only the providers in use.
 * Created with IF NOT EXISTS like the other ensured objects (`COORDINATION_FILE.ensure`). WITHOUT ROWID: the read every
 * model request starts with is one probe of the primary key.
 */
export const PROVIDER_COOLDOWNS_SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_cooldowns (
  provider TEXT NOT NULL PRIMARY KEY, until_ms INTEGER NOT NULL, pause_ms INTEGER NOT NULL) WITHOUT ROWID;
`;
