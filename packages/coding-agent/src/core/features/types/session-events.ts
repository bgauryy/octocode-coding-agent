/** Startup, resource and session lifecycle events. */

import type { CompactionPreparation, SummaryRequestPolicy } from "../../compaction/index.ts";
import type { RegisteredMcpServer } from "@octocodeai/octocode-contracts/mcp-server";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionNameSource } from "../../session-manager.ts";

// Startup/Resource Events
// ============================================================================

/** Fired after session_start to allow extensions to provide additional resource paths. */
export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}

/**
 * Fired when an extension registers or unregisters an MCP server after the extensions are bound
 * (see {@link ExtensionAPI.registerMcpServer}). Servers registered while extensions load are read
 * with `api.getMcpServers()` on `session_start`. Handling this event marks an extension as the one
 * that connects registered servers.
 */
export interface McpServersChangeEvent {
	type: "mcp_servers_change";
	/** Every registered server after the change. */
	servers: RegisteredMcpServer[];
}

// Session Events
// ============================================================================

/** Fired when a session is started, loaded, or reloaded */
export interface SessionStartEvent {
	type: "session_start";
	/** Why this session start happened. */
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	/** Previously active session file. Present for "new", "resume", and "fork". */
	previousSessionFile?: string;
}

/** Fired when the current session metadata changes. */
export interface SessionInfoChangedEvent {
	type: "session_info_changed";
	/** Current normalized session name. Undefined when the name is cleared. */
	name: string | undefined;
	/** Who gave the name (user, generated title, subagent goal). Undefined when the name is cleared. */
	source?: SessionNameSource;
}

/** Fired before switching to another session (can be cancelled) */
export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";
	reason: "new" | "resume";
	targetSessionFile?: string;
}

/** Fired before forking a session (can be cancelled) */
export interface SessionBeforeForkEvent {
	type: "session_before_fork";
	entryId: string;
	position: "before" | "at";
}

/** Fired before `/quit` ends the session (can be cancelled) */
export interface SessionBeforeQuitEvent {
	type: "session_before_quit";
}

/** Fired before context compaction. Return values are ignored; preparation is an isolated snapshot. */
export interface SessionBeforeCompactEvent {
	customInstructions?: string;
	type: "session_before_compact";
	preparation: CompactionPreparation;
	branchEntries: SessionEntry[];
	/** What triggered the compaction: manual /compact, the context threshold, or context overflow recovery */
	reason: "manual" | "threshold" | "overflow";
	/** True when the aborted turn is retried after this compaction (overflow recovery) */
	willRetry: boolean;
	signal: AbortSignal;
	/**
	 * How the session sends this compaction's summary requests: an extension that writes the summary itself wraps its
	 * stream function with `watch` (progress on the status line, a silent attempt ended as a retryable timeout) and
	 * retries by `retry`. Absent when a caller builds the event without a session.
	 */
	summaryRequest?: SummaryRequestPolicy;
}

/**
 * Fired when the context nears the compaction threshold, while the run goes on: a handler may request the summary of
 * `preparation` now, so the compaction that follows reuses it instead of holding the turn while it is written. That
 * compaction passes the same `preparation` to `session_before_compact`. Return values are ignored; `signal` aborts when
 * the plan is dropped (another compaction, a changed branch or model, an abort of the session).
 */
export interface SessionCompactPrewarmEvent {
	type: "session_compact_prewarm";
	preparation: CompactionPreparation;
	branchEntries: SessionEntry[];
	signal: AbortSignal;
	/** As on `session_before_compact`, without progress or retry notices: nothing is shown for a background request. */
	summaryRequest?: SummaryRequestPolicy;
}

/** Fired after context compaction succeeds */
export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;
	fromExtension: boolean;
	/** What triggered the compaction: manual /compact, the context threshold, or context overflow recovery */
	reason: "manual" | "threshold" | "overflow";
	/** True when the aborted turn is retried after this compaction (overflow recovery) */
	willRetry: boolean;
}

/** Fired after context compaction fails or is aborted */
export interface SessionCompactFailedEvent {
	type: "session_compact_failed";
	/** What triggered the compaction: manual /compact, the context threshold, or context overflow recovery */
	reason: "manual" | "threshold" | "overflow";
	/** Error text when compaction failed for a non-abort reason. */
	errorMessage?: string;
	/** True when compaction was cancelled or aborted. */
	aborted: boolean;
	/** True when the aborted turn would have been retried after this compaction (overflow recovery) */
	willRetry: boolean;
	/** True when the failing compaction content came from a session_before_compact handler. */
	fromExtension: boolean;
}

/** Fired before an extension runtime is torn down due to quit, reload, or session replacement. */
export interface SessionShutdownEvent {
	type: "session_shutdown";
	reason: "quit" | "reload" | "new" | "resume" | "fork";
	/** Destination session file when shutting down due to session replacement. */
	targetSessionFile?: string;
}

/** Preparation data for tree navigation */
export interface TreePreparation {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: SessionEntry[];
	userWantsSummary: boolean;
	customInstructions?: string;
	/** If true, customInstructions replaces the default prompt instead of being appended */
	replaceInstructions?: boolean;
	/** Label to attach to the branch summary entry */
	label?: string;
}

/** Fired before navigating in the session tree (can be cancelled) */
export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	preparation: TreePreparation;
	signal: AbortSignal;
}

/** Fired after navigating in the session tree */
export interface SessionTreeEvent {
	type: "session_tree";
	newLeafId: string | null;
	oldLeafId: string | null;
	summaryEntry?: BranchSummaryEntry;
	fromExtension?: boolean;
}

export type SessionEvent =
	| SessionStartEvent
	| SessionInfoChangedEvent
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionBeforeQuitEvent
	| SessionBeforeCompactEvent
	| SessionCompactPrewarmEvent
	| SessionCompactEvent
	| SessionCompactFailedEvent
	| SessionShutdownEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent;
