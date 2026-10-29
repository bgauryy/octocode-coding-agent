/** Startup, resource and session lifecycle events. */

import type { CompactionPreparation } from "../../compaction/index.ts";
import type { RegisteredMcpServer } from "../../../../../mcp/src/servers.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry } from "../../session-manager.ts";
import type { ExtensionMode } from "./context.ts";
import type { ExtensionUIContext } from "./ui.ts";

// ============================================================================
// Startup/Resource Events
// ============================================================================

export interface ProjectTrustEvent {
	type: "project_trust";
	cwd: string;
}

export type ProjectTrustEventDecision = "yes" | "no" | "undecided";

export interface ProjectTrustEventResult {
	trusted: ProjectTrustEventDecision;
	remember?: boolean;
}

export interface ProjectTrustContext {
	cwd: string;
	mode: ExtensionMode;
	hasUI: boolean;
	ui: Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify">;
}

export type ProjectTrustHandler = (
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
) => Promise<ProjectTrustEventResult> | ProjectTrustEventResult;

/** Fired after session_start to allow extensions to provide additional resource paths. */
export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

/** Result from resources_discover event handler */
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

// ============================================================================
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
	/** Custom instructions for summarization */
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
	| SessionBeforeCompactEvent
	| SessionCompactEvent
	| SessionCompactFailedEvent
	| SessionShutdownEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent;
