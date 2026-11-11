/**
 * The agent database API: the one door to it. Every SQL statement against the `workspaces.db` schema lives in `queries/`, one
 * module per table family, as a named function that takes the open `DatabaseSync` (`AgentDb.db`) and returns plain
 * values or rows already mapped. Features import the namespace they need from here and never call `prepare`/`exec`
 * themselves; `scripts/check-db-boundary.mjs` fails when they do, or when they import a private query module.
 * Connections come from `sharedDatabase` (one per process and file) or `openDatabase`; transactions stay with
 * `AgentDb.transaction`.
 */
export * as workspaces from "./queries/workspaces.ts";
export * as agentEvents from "./queries/agent-events.ts";
export * as compactions from "./queries/compactions.ts";
export * as agents from "./queries/agents.ts";
export * as agentRuns from "./queries/agent-runs.ts";
export { resolveAgent, itemRef, parseItemRef } from "./queries/agent-resolve.ts";
export * as deliveries from "./queries/deliveries.ts";
export * as correspondence from "./queries/correspondence.ts";
export * as leases from "./queries/leases.ts";
export * as edits from "./queries/edits.ts";
export * as backlog from "./queries/backlog.ts";
export * as tasks from "./queries/tasks.ts";
export * as memories from "./queries/memories.ts";
export * as transcripts from "./queries/transcripts.ts";
export * as sessions from "./queries/sessions.ts";
export * as sessionLinks from "./queries/session-links.ts";
export * as commands from "./queries/commands.ts";
export * as meta from "./queries/meta.ts";
export * as configAudits from "./queries/config-audits.ts";
export * as history from "./queries/history.ts";
export * as trust from "./queries/trust.ts";
export * as processSamples from "./queries/process-samples.ts";
export * as purge from "./queries/purge.ts";
export * as maintenance from "./queries/maintenance.ts";
export * as expire from "./queries/expire.ts";
export * as timers from "./queries/timers.ts";
export * as shellHistory from "./queries/shell-history.ts";
export { type AgentDb, type Db, dbStamp, closeSharedAgentDb, openDatabase, sharedDatabase } from "./db.ts";
export { AgentDbError } from "./schema.ts";
export { USER_AUTHOR } from "./author.ts";
export { allRows, num, type Row } from "./rows.ts";
export { openReadOnlyDb } from "./sqlite.ts";
export type { AgentRun, RunStart, RunOutcome } from "./queries/agent-runs.ts";
export type { ResolvedAgent, ItemLinkRef } from "./queries/agent-resolve.ts";
export type { ItemRow } from "./queries/backlog.ts";
export type { TaskRow } from "./queries/tasks.ts";
export type { MemoryFilter, MemoryScope, ScopeFilter } from "./queries/memories.ts";
export type { SessionLinks } from "./queries/session-links.ts";
export type { CatalogEntry, CatalogRow, EraseCounts, SessionExtra } from "./queries/sessions.ts";
export type { OwnedChild, ProcessSample } from "./queries/process-samples.ts";
export type { PurgeCounts } from "./queries/purge.ts";
export type { MaintenanceResult } from "./queries/maintenance.ts";
export type { ExpireCounts } from "./queries/expire.ts";
export type { NewTimer, TimerConditionKind, TimerKind, TimerResult, TimerRow, TimerStatus } from "./queries/timers.ts";
export type { ConfigAuditEntry } from "./queries/config-audits.ts";
export type { ShellHistoryRow } from "./queries/shell-history.ts";
export type { FolderDecision, FolderGrantRow, FolderIdentity } from "./queries/trust.ts";
export { archivedAudits } from "./history-archive.ts";
export { archiveHistory, scheduleHistoryArchive } from "./retention.ts";
export { DEFAULT_HISTORY_WINDOWS, type HistoryWindows } from "./history-archive.ts";
export { bindingKey, sameBinding } from "./binding.ts";

export type { WorkspaceGit, WorkspaceIdentity } from "./queries/workspaces.ts";
