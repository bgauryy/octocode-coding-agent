/**
 * The agent database API: the one door to it. Every statement that reads or writes rows of the coordination file
 * (`workspaces.db`) or of the transcript mirror beside it (`transcripts.db`: `transcripts`, `compactions`; `AgentDb.mirror`)
 * lives in `queries/`, one module per table family, as a named function that takes the open `DatabaseSync` (`AgentDb.db`)
 * and returns plain values or rows already mapped. Schema creation (`schema.ts`), connection PRAGMAs and transactions (`db.ts`) and the busy helpers (`sqlite.ts`) run their own SQL. Features import the namespace they need from here and never call `prepare`/`exec`
 * themselves; `scripts/check-db-boundary.mjs` fails when they do, or when they import a private query module.
 * Connections come from `sharedDatabase` (one per process and file) or `openDatabase`; transactions stay with
 * `AgentDb.transaction` (`AgentDb.mirror.transaction` for the mirror, whose lock is taken first, never inside a
 * coordination transaction). Derived writes that must not wait on the calling thread go to `sharedDbWriter` (the
 * coordination file's bookkeeping) or `sharedMirrorWriter` (the transcript mirror), one worker per file, as typed
 * commands (`writer/`).
 */
export * as workspaces from "./queries/workspaces.ts";
export * as agentEvents from "./queries/agent-events.ts";
export * as events from "./queries/events.ts";
export * as eventSubscriptions from "./queries/event-subscriptions.ts";
export * as tickets from "./queries/tickets.ts";
export * as compactions from "./queries/compactions.ts";
export * as agents from "./queries/agents.ts";
export * as agentRuns from "./queries/agent-runs.ts";
export * as agentRunChildren from "./queries/agent-run-children.ts";
export { resolveAgent, itemRef, parseItemRef } from "./queries/agent-resolve.ts";
export * as deliveries from "./queries/deliveries.ts";
export * as correspondence from "./queries/correspondence.ts";
export * as leases from "./queries/leases.ts";
export * as edits from "./queries/edits.ts";
export * as backlog from "./queries/backlog.ts";
export * as tasks from "./queries/tasks.ts";
export * as memories from "./queries/memories.ts";
export * as archiveIndex from "./queries/archive-index.ts";
export * as transcripts from "./queries/transcripts.ts";
export * as forks from "./queries/forks.ts";
export * as sessions from "./queries/sessions.ts";
export * as sessionLinks from "./queries/session-links.ts";
export * as commands from "./queries/commands.ts";
export * as meta from "./queries/meta.ts";
export * as configAudits from "./queries/config-audits.ts";
export * as history from "./queries/history.ts";
export * as trust from "./queries/trust.ts";
export * as guard from "./queries/guard.ts";
export * as apiReceipts from "./queries/api-receipts.ts";
export * as openings from "./queries/openings.ts";
export type { Opening } from "./queries/openings.ts";
export * as itemHandoffs from "./queries/item-handoffs.ts";
export * as processSamples from "./queries/process-samples.ts";
export * as machineSamples from "./queries/machine-samples.ts";
export * as purge from "./queries/purge.ts";
export * as maintenance from "./queries/maintenance.ts";
export * as expire from "./queries/expire.ts";
export * as timers from "./queries/timers.ts";
export * as jobs from "./queries/jobs.ts";
export * as shellHistory from "./queries/shell-history.ts";
export {
	type AgentDb,
	type Db,
	dbStamp,
	type MirrorDb,
	openDatabase,
	openArchiveIndex,
	type ArchiveIndexDb,
	prepareSharedDatabase,
	sharedDatabase,
} from "./db.ts";
export { isBusy, withoutWaiting } from "./sqlite.ts";
export { transactionWhenReady } from "./transaction-ready.ts";
export {
	closeSharedAgentDb,
	DB_WRITER_QUEUE_LIMIT,
	DbWriter,
	DbWriterBusyError,
	DbWriterCommandError,
	DbWriterUnavailableError,
	type DbWriterErrorKind,
	type DbWriterFallback,
	type DbWriterStats,
	dbWriterStats,
	drainDbWriters,
	sharedDbWriter,
	sharedMirrorWriter,
	writerErrorKind,
} from "./writer/client.ts";
export type { DbWriterLocations } from "./writer/protocol.ts";
export type {
	FileStamp,
	MirrorRecord,
	MirrorWorkspace,
	TranscriptCommand,
	TranscriptResult,
} from "./writer/transcript-mirror.ts";
export { AgentDbError } from "./schema.ts";
export { fileReport, type FileReport } from "./file-report.ts";
export { USER_AUTHOR } from "./author.ts";
export { allRows, num, type Row } from "./rows.ts";
export { openReadOnlyDb } from "./sqlite.ts";
export type { AgentRun, RunStart, RunOutcome } from "./queries/agent-runs.ts";
export type { ResolvedAgent, ItemLinkRef } from "./queries/agent-resolve.ts";
export type { ItemRow, ItemStatRow } from "./queries/backlog.ts";
export type { TaskRow } from "./queries/tasks.ts";
export type { MemoryFilter, MemoryScope, ScopeFilter } from "./queries/memories.ts";
export type { SessionLinks } from "./queries/session-links.ts";
export type { CatalogEntry, CatalogRow, EraseCounts, SessionExtra } from "./queries/sessions.ts";
export type { OwnedChild, ProcessSample } from "./queries/process-samples.ts";
export type { MachineAlertRow, MachineProcess, MachineSample, SamplerLease } from "./queries/machine-samples.ts";
export type { PurgeCounts } from "./queries/purge.ts";
export type { MaintenanceResult } from "./queries/maintenance.ts";
export type { ExpireCounts } from "./queries/expire.ts";
export type { JobRow, JobState, NewJob } from "./queries/jobs.ts";
export type { Appended, EventRow, NewEvent, ReadOptions } from "./queries/events.ts";
export type { Deliver, NewSubscription, SubscriptionRow } from "./queries/event-subscriptions.ts";
export type { NewTicket, TicketOutcome, TicketRow, TicketState } from "./queries/tickets.ts";
export type { NewTimer, TimerConditionKind, TimerKind, TimerResult, TimerRow, TimerStatus } from "./queries/timers.ts";
export type { ConfigAuditEntry } from "./queries/config-audits.ts";
export type { ShellHistoryRow } from "./queries/shell-history.ts";
export type { FolderDecision, FolderGrantRow, FolderIdentity } from "./queries/trust.ts";
export type { ReviewDecision, ReviewInput, ReviewKey, ReviewRow } from "./queries/guard.ts";
export { archivedAudits } from "./history-archive.ts";
export { archiveHistory } from "./retention.ts";
export { historyArchivesSettled, scheduleHistoryArchive } from "./history-scheduler.ts";
export { DEFAULT_HISTORY_WINDOWS, type HistoryWindows } from "./history-archive.ts";

export type { WorkspaceGit, WorkspaceIdentity } from "./queries/workspaces.ts";
