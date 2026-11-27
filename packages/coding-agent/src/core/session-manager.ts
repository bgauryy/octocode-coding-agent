import type { EntryReceipt } from "./session-manager/entry-receipt.ts";
import type { ImageContent, Message, TextContent, Usage } from "@octocodeai/octocode-ai";
import { existsSync } from "node:fs";
import { normalizePath, resolvePath } from "@octocodeai/octocode-common/paths";
import type { BashExecutionMessage, CustomMessage, MessageDisplay } from "./messages.ts";
import type { SessionManagerApi } from "./session-manager/api.ts";
import * as appends from "./session-manager/appends.ts";
import { loadSessionFileAsync, type LoadedSessionFile } from "./session-manager/file-reader.ts";
import { findSessionFileById, listAllSessions, listSessions } from "./session-manager/listing.ts";
import { recordFork } from "./session-manager/mirror.ts";
import * as persistence from "./session-manager/persistence.ts";
import { SessionReader } from "./session-manager/reader.ts";
import type { SessionRepair } from "./session-manager/repair.ts";
import * as sessionState from "./session-manager/state.ts";
import {
	findMostRecentForCwd,
	forkSessionFile,
	forkSessionFileAsync,
	getDefaultSessionDir,
	resolveOpenedSession,
} from "./session-manager/storage.ts";
import type {
	InputOrigin,
	ContextEditEntry,
	FileEntry,
	NewSessionOptions,
	SessionEntry,
	SessionInfo,
	SessionListProgress,
	SessionNameSource,
	UsageEntry,
} from "./session-manager/types.ts";

export type { ReadonlySessionManager } from "./session-manager/api.ts";
export {
	buildContextEntries,
	buildSessionContext,
	buildSessionProjection,
	sessionEntryToContextMessages,
} from "./session-manager/context.ts";
export { assertValidSessionId, parseSessionEntries } from "./session-manager/entries.ts";
export { findMostRecentSession, loadEntriesFromFile } from "./session-manager/storage.ts";
export { hasTornTail } from "./session-manager/session-tail.ts";
export { repairSessionFile, type SessionRepair } from "./session-manager/repair.ts";
export * from "./session-manager/types.ts";

/**
 * Manages conversation sessions as append-only trees stored in JSONL files.
 *
 * Each session entry has an id and parentId forming a tree structure. The "leaf"
 * pointer tracks the current position. Appending creates a child of the current leaf.
 * Branching moves the leaf to an earlier entry, allowing new branches without
 * modifying history.
 *
 * Use buildSessionContext() to get the resolved message list for the LLM, which
 * handles compaction summaries and follows the path from root to current leaf.
 *
 */
export class SessionManager extends SessionReader implements SessionManagerApi {
	/** Set by `retire()` once the runtime replaced this manager. */
	private retired = false;

	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		newSessionOptions?: NewSessionOptions,
		preloadedFileEntries?: FileEntry[],
		loadedFile?: LoadedSessionFile,
		sessionDirFromFile = false,
	) {
		super(sessionState.createSessionState(resolvePath(cwd), normalizePath(sessionDir), persist, sessionDirFromFile));
		persistence.initializeSession(this.state, sessionFile, newSessionOptions, preloadedFileEntries, loadedFile);
	}

	/** Reports this session's database-mirror problems to `handler` instead of the process-wide handler or stderr. */
	setNoticeHandler(handler: ((message: string) => void) | undefined): void {
		this.state.notice = handler;
	}

	setSessionFile(sessionFile: string): void {
		persistence.setSessionFile(this.state, sessionFile);
	}

	/** Cuts a torn final record off the file (a `.bak` keeps the original) and reloads it; undefined when nothing was torn. */
	recover(): SessionRepair | undefined {
		return persistence.recoverSession(this.state);
	}

	newSession(options?: NewSessionOptions): string | undefined {
		return persistence.startNewSession(this.state, options);
	}

	/** Rewrites the whole session file atomically (`persistence.ts`); storage tests call it directly. */
	private _rewriteFile(): void {
		persistence.rewriteSessionFile(this.state);
	}

	_persist(entry: SessionEntry): void {
		persistence.persistEntry(this.state, entry);
	}

	/** Explicitly make an empty session discoverable before any conversation entries exist. */
	materialize(): void {
		persistence.materializeSession(this.state);
	}

	appendMessage(message: Message | CustomMessage | BashExecutionMessage, origin?: InputOrigin): string {
		return appends.appendMessage(this.state, message, origin);
	}

	appendThinkingLevelChange(thinkingLevel: string): string {
		return appends.appendThinkingLevelChange(this.state, thinkingLevel);
	}

	appendModelChange(provider: string, modelId: string): string {
		return appends.appendModelChange(this.state, provider, modelId);
	}

	retire(): void {
		this.retired = true;
		persistence.writeHeldEntries(this.state);
	}

	captureUsageWriter(): SessionManager["appendUsage"] {
		const { sessionId, sessionFile, fileEntries: entries, cwd, sessionDir, persist } = this.state;
		let detached: SessionManager | undefined;
		return (...args) => {
			if (!this.retired && this.state.sessionId === sessionId && this.state.sessionFile === sessionFile)
				return this.appendUsage(...args);
			// Reload the original file so a late receipt never rewrites a stale snapshot or branches from an old leaf.
			if (persist && sessionFile && existsSync(sessionFile)) {
				const origin = SessionManager.open(sessionFile, sessionDir, cwd);
				if (origin.getSessionId() !== sessionId) throw new Error("Originating usage session identity changed");
				return origin.appendUsage(...args);
			}
			detached ??= new SessionManager(cwd, sessionDir, undefined, persist, undefined, [...entries]);
			if (persist) detached.state.sessionFile = sessionFile;
			return detached.appendUsage(...args);
		};
	}

	appendUsage(
		kind: string,
		provider: string,
		model: string,
		usage: Usage,
		note?: string,
		cacheRequestedAt?: number,
	): UsageEntry {
		return appends.appendUsage(this.state, kind, provider, model, usage, note, cacheRequestedAt);
	}

	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string | null,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		return appends.appendCompaction(this.state, summary, firstKeptEntryId, tokensBefore, details, fromHook, usage);
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		return appends.appendCustomEntry(this.state, customType, data);
	}

	appendSessionInfo(name: string, source?: SessionNameSource): string {
		return appends.appendSessionInfo(this.state, name, source);
	}

	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: MessageDisplay,
		details?: T,
		timestamp?: number,
		receipt?: EntryReceipt,
	): string {
		return appends.appendCustomMessageEntry(this.state, customType, content, display, details, timestamp, receipt);
	}

	appendContextEdit(targetId: string, replacement: ContextEditEntry["replacement"]): string {
		return appends.appendContextEdit(this.state, targetId, replacement);
	}

	appendLabelChange(targetId: string, label: string | undefined): string {
		return appends.appendLabelChange(this.state, targetId, label);
	}

	branch(branchFromId: string): void {
		if (!this.state.byId.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
		this.state.leafId = branchFromId;
	}

	resetLeaf(): void {
		this.state.leafId = null;
	}

	branchWithSummary(
		branchFromId: string | null,
		summary: string,
		details?: unknown,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		return appends.branchWithSummary(this.state, branchFromId, summary, details, fromHook, usage);
	}

	createBranchedSession(leafId: string): string | undefined {
		return persistence.createBranchedSession(this.state, leafId);
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in session header)
	 * @param sessionDir Optional session directory. If omitted, uses default (<workspace>/.octocode/agent/sessions/).
	 */
	static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, undefined, true, options);
	}

	/**
	 * Open a specific session file.
	 * @param path Path to session file
	 * @param sessionDir Optional session directory for /new or /branch. If omitted, derives from file's parent.
	 * @param cwdOverride Optional cwd override instead of the session header cwd.
	 */
	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		const { cwd, dir, dirFromFile, resolvedPath, preloadedFileEntries } = resolveOpenedSession(
			path,
			sessionDir,
			cwdOverride,
		);
		return new SessionManager(cwd, dir, resolvedPath, true, undefined, preloadedFileEntries, undefined, dirFromFile);
	}

	/** Open while yielding disk reads and transcript decoding to input; reuse the resulting codec and indexes. */
	static async openAsync(
		path: string,
		sessionDir?: string,
		cwdOverride?: string,
		signal?: AbortSignal,
	): Promise<SessionManager> {
		const loaded = await loadSessionFileAsync(resolvePath(path), signal);
		const header = loaded.entries[0];
		const { cwd, dir, dirFromFile, resolvedPath } = resolveOpenedSession(
			path,
			sessionDir,
			cwdOverride,
			header?.type === "session" ? header : null,
		);
		signal?.throwIfAborted();
		return new SessionManager(cwd, dir, resolvedPath, true, undefined, undefined, loaded, dirFromFile);
	}

	/**
	 * Continue the most recent session, or create new if none.
	 * @param cwd Working directory
	 * @param sessionDir Optional session directory. If omitted, uses the workspace folder.
	 */
	static continueRecent(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, findMostRecentForCwd(cwd, sessionDir && dir) ?? undefined, true);
	}

	static async continueRecentAsync(cwd: string, sessionDir?: string): Promise<SessionManager> {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const file = findMostRecentForCwd(cwd, sessionDir && dir);
		return file ? SessionManager.openAsync(file, dir, cwd) : new SessionManager(cwd, dir, undefined, true);
	}

	/** Create an in-memory session (no file persistence), optionally from entries held outside the filesystem. */
	static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions, entries?: FileEntry[]): SessionManager {
		return new SessionManager(cwd, "", undefined, false, options, entries);
	}

	/**
	 * Fork a session from another project directory into the current project.
	 * Creates a new session in the target cwd with the full history from the source session.
	 * @param sourcePath Path to the source session file
	 * @param targetCwd Target working directory (where the new session will be stored)
	 * @param sessionDir Optional session directory. If omitted, uses default for targetCwd.
	 */
	static forkFrom(
		sourcePath: string | { storedId: string },
		targetCwd: string,
		sessionDir?: string,
		options?: NewSessionOptions,
	): SessionManager {
		const { cwd, dir, sessionFile, sourceFile, sourceId } = forkSessionFile(sourcePath, targetCwd, sessionDir, options);
		const fork = new SessionManager(cwd, dir, sessionFile, true);
		recordFork(
			cwd,
			fork.getSessionId(),
			sessionFile,
			typeof sourcePath === "string" ? { file: sourceFile, expectedId: sourceId } : sourcePath,
		);
		return fork;
	}

	/** `forkFrom` reading the source, writing the fork and opening it without blocking input. */
	static async forkFromAsync(
		sourcePath: string | { storedId: string },
		targetCwd: string,
		sessionDir?: string,
		options?: NewSessionOptions,
		signal?: AbortSignal,
	): Promise<SessionManager> {
		const { cwd, dir, sessionFile, sourceFile, sourceId } = await forkSessionFileAsync(
			sourcePath,
			targetCwd,
			sessionDir,
			options,
			signal,
		);
		const fork = await SessionManager.openAsync(sessionFile, dir, cwd);
		recordFork(
			cwd,
			fork.getSessionId(),
			sessionFile,
			typeof sourcePath === "string" ? { file: sourceFile, expectedId: sourceId } : sourcePath,
		);
		return fork;
	}

	/**
	 * Find an exact session ID without loading transcript bodies.
	 * @param cwd Working directory (used to compute default session directory)
	 * @param id Exact session ID
	 * @param sessionDir Optional session directory. If omitted, uses default (<workspace>/.octocode/agent/sessions/).
	 */
	static findById(cwd: string, id: string, sessionDir?: string): string | undefined {
		return findSessionFileById(cwd, id, sessionDir);
	}

	/**
	 * List all sessions for a directory.
	 * @param cwd Working directory (used to compute default session directory)
	 * @param sessionDir Optional session directory. If omitted, uses default (<workspace>/.octocode/agent/sessions/).
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async list(
		cwd: string,
		sessionDir?: string,
		onProgress?: SessionListProgress,
		signal?: AbortSignal,
	): Promise<SessionInfo[]> {
		return listSessions(cwd, sessionDir, onProgress, signal);
	}

	/**
	 * List all sessions across all project directories.
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async listAll(onProgress?: SessionListProgress, signal?: AbortSignal): Promise<SessionInfo[]>;
	static async listAll(
		sessionDir?: string,
		onProgress?: SessionListProgress,
		signal?: AbortSignal,
	): Promise<SessionInfo[]>;
	static async listAll(
		sessionDirOrOnProgress?: string | SessionListProgress,
		onProgressOrSignal?: SessionListProgress | AbortSignal,
		signal?: AbortSignal,
	): Promise<SessionInfo[]> {
		return listAllSessions(sessionDirOrOnProgress, onProgressOrSignal, signal);
	}
}
