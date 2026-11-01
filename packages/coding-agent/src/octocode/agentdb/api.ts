/**
 * The agent database API: the one door to it. Every SQL statement against the `octocode.db` schema lives in `queries/`, one
 * module per table family, as a named function that takes the open `DatabaseSync` (`AgentDb.db`) and returns plain
 * values or rows already mapped. Features import the namespace they need from here and never call `prepare`/`exec`
 * themselves; `scripts/check-db-boundary.mjs` fails when they do, or when they import any other `agentdb/` module.
 * Connections come from `sharedAgentDb` (one per process and file) or `openAgentDb`; transactions stay with
 * `AgentDb.transaction`.
 */
export * as agents from "./queries/agents.ts";
export * as deliveries from "./queries/deliveries.ts";
export * as leases from "./queries/leases.ts";
export * as edits from "./queries/edits.ts";
export * as backlog from "./queries/backlog.ts";
export * as tasks from "./queries/tasks.ts";
export * as memories from "./queries/memories.ts";
export * as sessions from "./queries/sessions.ts";
export * as sessionLinks from "./queries/session-links.ts";
export * as commands from "./queries/commands.ts";
export * as meta from "./queries/meta.ts";
export * as configAudits from "./queries/config-audits.ts";
export * as history from "./queries/history.ts";
export { type AgentDb, type Db, dbStamp, openAgentDb, sharedAgentDb } from "./db.ts";
export { AgentDbError } from "./schema.ts";
export { USER_AUTHOR } from "./author.ts";
export { runningPid, sessionFileRunningPid, sessionRunningPid } from "./liveness.ts";
export { allRows, num, type Row } from "./rows.ts";
export { openReadOnlyDb } from "./sqlite.ts";
export type { ItemRow } from "./queries/backlog.ts";
export type { TaskRow } from "./queries/tasks.ts";
export type { MemoryFilter, MemoryScope, ScopeFilter } from "./queries/memories.ts";
export type { SessionLinks } from "./queries/session-links.ts";
export type { CatalogEntry, CatalogRow, SessionExtra } from "./queries/sessions.ts";
export type { ConfigAuditEntry } from "./queries/config-audits.ts";
export type { HistoryTable } from "./queries/history.ts";
