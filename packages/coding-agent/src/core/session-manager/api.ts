import type { ImageContent, Message, TextContent, Usage } from "@octocodeai/octocode-ai";
import type { BashExecutionMessage, CustomMessage } from "../messages.ts";
import type {
	InputOrigin,
	ContextEditEntry,
	NewSessionOptions,
	SessionContext,
	SessionEntry,
	SessionHeader,
	ReadonlySessionProjection,
	SessionNameSource,
	SessionProjection,
	SessionTreeNode,
	UsageEntry,
} from "./types.ts";
import type { SessionRepair } from "./repair.ts";

/** Instance surface of `SessionManager`; static factories stay on the class. */
export interface SessionManagerApi {
	/** Switch to a different session file (used for resume and branching) */
	setSessionFile(sessionFile: string): void;

	/**
	 * Repair a session whose final record is torn (the file does not end in a newline), which blocks every later write:
	 * copy it to a `.bak`, truncate it to the last complete line and reload it. Returns undefined when nothing was torn.
	 */
	recover(): SessionRepair | undefined;

	newSession(options?: NewSessionOptions): string | undefined;

	isPersisted(): boolean;

	getCwd(): string;

	getSessionDir(): string;

	usesDefaultSessionDir(): boolean;

	getSessionId(): string;

	getSessionFile(): string | undefined;

	/** Append a message as child of current leaf, then advance leaf. Returns entry id.
	 * Does not allow writing CompactionSummaryMessage and BranchSummaryMessage directly.
	 * Reason: we want these to be top-level entries in the session, not message session entries,
	 * so it is easier to find them.
	 * These need to be appended via appendCompaction() and appendBranchSummary() methods.
	 */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage, origin?: InputOrigin): string;

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel: string): string;

	/** Append a model change as child of current leaf, then advance leaf. Returns entry id. */
	appendModelChange(provider: string, modelId: string): string;

	/**
	 * Mark this manager as replaced: the session it held may be opened again by another manager, so late writes captured
	 * from this one reload the file instead of appending from this manager's leaf.
	 */
	retire(): void;

	/** Capture the originating session for usage returned after a request has been cancelled or replaced. */
	captureUsageWriter(): SessionManagerApi["appendUsage"];

	/** Append model-attributed usage that does not participate in LLM context. Returns the appended entry. */
	appendUsage(
		kind: string,
		provider: string,
		model: string,
		usage: Usage,
		note?: string,
		cacheRequestedAt?: number,
	): UsageEntry;

	/** Append a compaction summary as child of current leaf, then advance leaf. Returns entry id. */
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string | null,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		usage?: Usage,
	): string;

	/** Append a custom entry (for extensions) as child of current leaf, then advance leaf. Returns entry id. */
	appendCustomEntry(customType: string, data?: unknown): string;

	/** Append a session info entry (e.g., display name); `source` defaults to `user`. Returns entry id. */
	appendSessionInfo(name: string, source?: SessionNameSource): string;

	/** Get the current session name from the latest session_info entry, if any. */
	getSessionName(): string | undefined;

	/** Who gave the current session name; undefined when there is no name. */
	getSessionNameSource(): SessionNameSource | undefined;

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Extension identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @param timestamp Creation time (ms) of a message that already exists in the live context; the entry keeps it so a
	 * context rebuilt from the session file equals the live message. Defaults to now.
	 * @returns Entry id
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
		timestamp?: number,
	): string;

	/** Append a branch-local edit to an earlier model-visible entry. */
	appendContextEdit(targetId: string, replacement: ContextEditEntry["replacement"]): string;

	// Tree Traversal
	// =========================================================================

	getLeafId(): string | null;

	getLeafEntry(): SessionEntry | undefined;

	getEntry(id: string): SessionEntry | undefined;

	/**
	 * Get all direct children of an entry.
	 */
	getChildren(parentId: string): SessionEntry[];

	/**
	 * Get the label for an entry, if any.
	 */
	getLabel(id: string): string | undefined;

	/**
	 * Set or clear a label on an entry.
	 * Labels are user-defined markers for bookmarking/navigation.
	 * Pass undefined or empty string to clear the label.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string;

	/**
	 * Walk from entry to root, returning all entries in path order.
	 * Includes all entry types (messages, compaction, model changes, etc.).
	 * Use buildSessionContext() to get the resolved messages for the LLM.
	 */
	getBranch(fromId?: string): SessionEntry[];

	/**
	 * Build the active, compaction-aware entry list for context/rendering.
	 * Uses tree traversal from current leaf.
	 */
	buildContextEntries(): SessionEntry[];

	/**
	 * Build the session context (what gets sent to the LLM).
	 * Uses tree traversal from current leaf.
	 */
	buildSessionProjection(): SessionProjection;

	/**
	 * `buildSessionProjection` without copying, for a reader that finishes before the session changes again: the next
	 * append may extend or replace the arrays it holds.
	 */
	readSessionProjection(): ReadonlySessionProjection;

	buildSessionContext(): SessionContext;

	/**
	 * Get session header.
	 */
	getHeader(): SessionHeader | null;

	/** Number of session entries (excludes header), without copying them like `getEntries()`. */
	getEntryCount(): number;

	/**
	 * Get all session entries (excludes header). Returns a shallow copy.
	 * The session is append-only: use appendXXX() to add entries, branch() to
	 * change the leaf pointer. Entries cannot be modified or deleted.
	 */
	getEntries(): SessionEntry[];

	/**
	 * Get the session as a tree structure. Returns a shallow defensive copy of all entries.
	 * A well-formed session has exactly one root (first entry with parentId === null).
	 * Orphaned entries (broken parent chain) are also returned as roots.
	 */
	getTree(): SessionTreeNode[];

	// Branching
	// =========================================================================

	/**
	 * Start a new branch from an earlier entry.
	 * Moves the leaf pointer to the specified entry. The next appendXXX() call
	 * will create a child of that entry, forming a new branch. Existing entries
	 * are not modified or deleted.
	 */
	branch(branchFromId: string): void;

	/**
	 * Reset the leaf pointer to null (before any entries).
	 * The next appendXXX() call will create a new root entry (parentId = null).
	 * Use this when navigating to re-edit the first user message.
	 */
	resetLeaf(): void;

	/**
	 * Start a new branch with a summary of the abandoned path.
	 * Same as branch(), but also appends a branch_summary entry that captures
	 * context from the abandoned conversation path.
	 */
	branchWithSummary(
		branchFromId: string | null,
		summary: string,
		details?: unknown,
		fromHook?: boolean,
		usage?: Usage,
	): string;

	/**
	 * Create a new session file containing only the path from root to the specified leaf.
	 * Useful for extracting a single conversation path from a branched session.
	 * Returns the new session file path, or undefined if not persisting.
	 */
	createBranchedSession(leafId: string): string | undefined;
}

export type ReadonlySessionManager = Pick<
	SessionManagerApi,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "buildContextEntries"
	| "buildSessionProjection"
	| "readSessionProjection"
	| "getHeader"
	| "getEntries"
	| "getEntryCount"
	| "getTree"
	| "getSessionName"
	| "getSessionNameSource"
>;
