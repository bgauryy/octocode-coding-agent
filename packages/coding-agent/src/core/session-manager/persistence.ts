import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { APP_NAME } from "../../config.ts";
import { atomicWriteFileSync } from "../../../../common/src/atomic-file.ts";
import { getFileStamp, resolvePath } from "../../../../common/src/paths.ts";
import {
	assertValidSessionId,
	createSessionHeader,
	createSessionId,
	getSessionFilePath,
	migrateToCurrentVersion,
} from "./entries.ts";
import { appendRecords } from "./append-records.ts";
import { encodeSessionLines, SessionCodec } from "./codec.ts";
import { mirrorOpened, mirrorReplaced, recordFork } from "./mirror.ts";
import { backupSessionFile, repairSessionFile, type SessionRepair } from "./repair.ts";
import { isSessionLockTimeout, lockSessionFile, mergeForeignEntries, withSessionFileLock } from "./shared-file.ts";
import { getBranchEntries, type SessionState } from "./state.ts";
import { assertCompleteSessionTail, loadEntriesFromFile, writeNewSessionFile } from "./storage.ts";
import { buildBranchedEntries, indexSessionEntries } from "./tree.ts";
import { CURRENT_SESSION_VERSION, type FileEntry, type NewSessionOptions, type SessionEntry } from "./types.ts";
import { blockWrites, liftWriteBlock } from "./write-recovery.ts";

/** Create the session directory when persisting, then open the session file, load preloaded entries or start a new session. */
export function initializeSession(
	state: SessionState,
	sessionFile: string | undefined,
	newSessionOptions?: NewSessionOptions,
	preloadedFileEntries?: FileEntry[],
): void {
	// An existing file needs no folder yet: a session opened from the legacy folder must not create a missing cwd tree.
	if (state.persist && state.sessionDir && !(sessionFile && existsSync(sessionFile)) && !existsSync(state.sessionDir)) {
		mkdirSync(state.sessionDir, { recursive: true });
	}

	if (sessionFile) {
		setSessionFile(state, sessionFile, preloadedFileEntries);
	} else if (preloadedFileEntries?.length) {
		loadEntries(state, preloadedFileEntries, newSessionOptions);
	} else {
		startNewSession(state, newSessionOptions);
	}
}

/** Switch the state to a session file, loading it when it exists and starting a new session at that path otherwise. */
export function setSessionFile(state: SessionState, sessionFile: string, preloadedFileEntries?: FileEntry[]): void {
	writeHeldEntries(state);
	const resolvedFile = resolvePath(sessionFile);
	if (existsSync(resolvedFile)) {
		// Take the size before reading: records another process appends after it are merged on the next write
		// (records the read already saw are skipped there by id).
		const sizeBeforeRead = preloadedFileEntries ? undefined : statSync(resolvedFile).size;
		const entries = preloadedFileEntries ?? loadEntriesFromFile(resolvedFile);

		// If file was empty, initialize it with a valid session header. If it was
		// non-empty but did not parse as an Octocode session, fail without modifying it.
		if (entries.length === 0) {
			const explicitPath = resolvedFile;
			if (statSync(explicitPath).size > 0) {
				throw new Error(`Session file is not a valid ${APP_NAME} session: ${explicitPath}`);
			}
			startNewSession(state);
			state.sessionFile = explicitPath;
			state.fileSize = 0;
			rewriteSessionFile(state);
			state.flushed = true;
			return;
		}

		const header = entries.find((entry) => entry.type === "session");
		if ((header?.version ?? 1) < CURRENT_SESSION_VERSION) assertCompleteSessionTail(resolvedFile);
		state.sessionFile = resolvedFile;
		state.fileSize = sizeBeforeRead ?? statSync(resolvedFile).size;
		state.codec = observedCodec(entries);
		loadEntries(state, entries);
		state.flushed = true;
		mirrorOpened(state, resolvedFile);
	} else {
		const explicitPath = resolvedFile;
		startNewSession(state);
		state.sessionFile = explicitPath; // preserve explicit path from --session flag
	}
	clearWriteState(state);
}

/** A codec that has observed `entries`, the whole entries of a file just read, in file order. */
function observedCodec(entries: readonly FileEntry[]): SessionCodec {
	const codec = new SessionCodec();
	for (const entry of entries) codec.observe(entry);
	return codec;
}

/** Forget what a failed or held write left: the session's file or transcript was just replaced. */
function clearWriteState(state: SessionState): void {
	state.persistenceFailure = undefined;
	state.failedWrite = undefined;
	state.unwritten.length = 0;
}

/**
 * Repair the torn tail of this session's file (`repairSessionFile`) and reload it, which also lifts the write block a
 * failed append left (`persistenceFailure`). Returns what was cut off, or undefined when the tail was complete. When
 * the file was never created (the first write failed), the transcript exists only in memory: it is kept, and the next
 * write creates the file with every entry.
 */
export function recoverSession(state: SessionState): SessionRepair | undefined {
	if (!state.persist || !state.sessionFile) throw new Error("Session persistence is disabled");
	if (!existsSync(state.sessionFile)) {
		state.flushed = false;
		state.fileSize = undefined;
		clearWriteState(state);
		return undefined;
	}
	const repair = repairSessionFile(state.sessionFile);
	setSessionFile(state, state.sessionFile);
	return repair;
}

export function startNewSession(state: SessionState, options?: NewSessionOptions): string | undefined {
	if (options?.id !== undefined) {
		assertValidSessionId(options.id);
	}
	writeHeldEntries(state);
	state.sessionId = options?.id ?? createSessionId();
	const timestamp = new Date().toISOString();
	state.fileEntries = [createSessionHeader(state.sessionId, timestamp, state.cwd, options?.parentSession)];
	state.codec = new SessionCodec();
	state.byId.clear();
	state.labelsById.clear();
	state.labelTimestampsById.clear();
	state.leafId = null;
	state.flushed = false;
	state.fileSize = undefined;
	clearWriteState(state);

	if (state.persist) {
		state.sessionFile = getSessionFilePath(state.sessionDir, timestamp, state.sessionId);
		if (options?.parentSession)
			recordFork(state.cwd, state.sessionId, state.sessionFile, { file: options.parentSession });
	}
	return state.sessionFile;
}

function loadEntries(state: SessionState, entries: FileEntry[], options?: NewSessionOptions): void {
	const header = entries.find((e) => e.type === "session");

	if (header) {
		state.fileEntries = entries;
		state.sessionId = header.id;

		if (migrateToCurrentVersion(state.fileEntries)) {
			// The rewrite keeps only the records that parsed: a `.bak` keeps the file as it was, malformed lines included.
			if (state.persist && state.sessionFile && existsSync(state.sessionFile)) backupSessionFile(state.sessionFile);
			rewriteSessionFile(state);
		}
	} else {
		startNewSession(state, options);
		state.fileEntries = state.fileEntries.concat(entries);
	}

	rebuildIndex(state);
}

function rebuildIndex(state: SessionState): void {
	state.leafId = indexSessionEntries(state.fileEntries, state.byId, state.labelsById, state.labelTimestampsById);
}

/** Records another process appended were merged while a rewrite waited for its lock: its prepared content is stale. */
class MergedWhileWriting extends Error {}

/**
 * Replace the file with this state's entries, after merging records another process appended since our last write.
 * The content is serialized and written to a temporary file before the lock is taken; the lock covers only the merge
 * check and the rename. When the merge brought in records, the content is serialized again (reusing the lines of
 * entries it did not touch) and written under the lock, as before.
 */
export function rewriteSessionFile(state: SessionState): void {
	const file = state.sessionFile;
	if (!state.persist || !file) return;
	mkdirSync(dirname(file), { recursive: true });
	// Each line is stored against the lines before it (`codec.ts`), so a merge that changes the entries encodes them all again.
	let encoded = encodeSessionLines(state.fileEntries);
	let lines = encoded.lines;
	let content = `${lines.join("\n")}\n`;
	let release: (() => void) | undefined;
	try {
		try {
			atomicWriteFileSync(file, content, {
				mode: 0o600,
				beforeCommit: () => {
					release = lockSessionFile(file);
					if (state.fileSize === undefined || !existsSync(file)) return;
					const count = state.fileEntries.length;
					mergeForeignEntries(state, file, state.unwritten);
					// Only a merge that brought records in reassigns held ids; otherwise the prepared lines are the file.
					if (state.fileEntries.length !== count) throw new MergedWhileWriting();
				},
			});
		} catch (error) {
			if (!(error instanceof MergedWhileWriting)) throw error;
			encoded = encodeSessionLines(state.fileEntries);
			lines = encoded.lines;
			content = `${lines.join("\n")}\n`;
			atomicWriteFileSync(file, content, { mode: 0o600 });
		}
		state.fileSize = Buffer.byteLength(content);
		state.codec = encoded.codec;
		state.unwritten.length = 0;
		const stamp = getFileStamp(file);
		release?.();
		release = undefined;
		mirrorReplaced(state, file, stamp, lines);
	} finally {
		release?.();
	}
}

/** Create the session file with every entry held so far; fails when the file already exists. */
function flushNewSessionFile(state: SessionState, file: string): void {
	withSessionFileLock(file, () => {
		const { lines, codec } = writeNewSessionFile(file, state.fileEntries);
		state.fileSize = statSync(file).size;
		state.codec = codec;
		state.flushed = true;
		state.unwritten.length = 0;
		mirrorReplaced(state, file, getFileStamp(file), lines);
	});
}

/** Explicitly persist an empty session for clients that expose reloadable IDs before the first prompt. */
export function materializeSession(state: SessionState): void {
	if (!state.persist || !state.sessionFile) throw new Error("Session persistence is disabled");
	liftWriteBlock(state);
	if (state.flushed) return;
	try {
		flushNewSessionFile(state, state.sessionFile);
	} catch (error) {
		// Another process held the lock past the wait: nothing was written, so a later write may retry.
		if (isSessionLockTimeout(error)) throw error;
		throw blockWrites(state, error);
	}
}

/**
 * A new session file is created only once the session contains a user or assistant message.
 * Setup entries alone (model, thinking level, system prompt) stay in memory so opening and
 * closing Octocode without chatting leaves no file behind. Starting at the user message (not the
 * first assistant reply) keeps the prompt on disk if the first turn never completes.
 */
function hasConversation(state: SessionState): boolean {
	return state.fileEntries.some(
		(e) => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"),
	);
}

/** Write the held entries, then `entry` when given. */
export function persistEntry(state: SessionState, entry?: SessionEntry): void {
	if (!state.persist || !state.sessionFile) return;
	liftWriteBlock(state);

	if (!state.flushed) {
		if (!hasConversation(state)) return;
		flushNewSessionFile(state, state.sessionFile);
	} else {
		const file = state.sessionFile;
		withSessionFileLock(file, () => {
			const pending = entry && !state.unwritten.includes(entry) ? [...state.unwritten, entry] : [...state.unwritten];
			mergeForeignEntries(state, file, pending);
			appendRecords(state, file, pending);
		});
	}
}

/** A message the session cannot produce again: dropping one would record a tool call or a reply as never finished. */
function cannotRegenerate(entry: SessionEntry): boolean {
	return entry.type === "message" && (entry.message.role === "toolResult" || entry.message.role === "assistant");
}

/**
 * Append an entry as the new leaf and persist it. A failed write rolls the entry back and blocks further writes until
 * one can succeed (`write-recovery.ts`). A lock another process held past the wait wrote nothing: a message that cannot
 * be regenerated then stays in memory and goes first at the next write; anything else is rolled back for the caller to retry.
 */
export function appendEntry(state: SessionState, entry: SessionEntry): void {
	liftWriteBlock(state);
	const previousLeaf = state.leafId;
	state.fileEntries.push(entry);
	state.byId.set(entry.id, entry);
	state.leafId = entry.id;
	try {
		persistEntry(state, entry);
	} catch (error) {
		if (isSessionLockTimeout(error) && cannotRegenerate(entry)) {
			state.unwritten.push(entry);
			return;
		}
		state.fileEntries.pop();
		state.byId.delete(entry.id);
		state.leafId = previousLeaf;
		if (isSessionLockTimeout(error)) throw error;
		throw blockWrites(state, error);
	}
}

/**
 * One more try at the entries held back by a lock, for a moment no later write will follow (the session is being
 * replaced or is quitting). Never throws: a failure leaves them unsaved, and a resume warns about any unanswered call.
 */
export function writeHeldEntries(state: SessionState): void {
	if (state.unwritten.length === 0 || state.persistenceFailure) return;
	try {
		persistEntry(state);
	} catch (error) {
		if (!isSessionLockTimeout(error)) blockWrites(state, error);
	}
}

/**
 * Replace the state with a new session containing only the path from root to the specified leaf.
 * Returns the new session file path, or undefined if not persisting.
 */
export function createBranchedSession(state: SessionState, leafId: string): string | undefined {
	writeHeldEntries(state);
	const previousSessionFile = state.sessionFile;
	const previousSessionId = state.sessionId;
	const path = getBranchEntries(state, leafId);
	if (path.length === 0) {
		throw new Error(`Entry ${leafId} not found`);
	}
	const entries = buildBranchedEntries(path, state.labelsById, state.labelTimestampsById, state.persist);

	const newSessionId = createSessionId();
	const timestamp = new Date().toISOString();
	const newSessionFile = getSessionFilePath(state.sessionDir, timestamp, newSessionId);
	const parentSession = state.persist ? previousSessionFile : undefined;
	const header = createSessionHeader(newSessionId, timestamp, state.cwd, parentSession);

	state.fileEntries = [header, ...entries];
	state.codec = new SessionCodec();
	state.sessionId = newSessionId;
	clearWriteState(state);
	if (state.persist) {
		state.sessionFile = newSessionFile;
		state.fileSize = undefined;
		rebuildIndex(state);

		// Use the same rule as persistEntry(): write now if the branched path already
		// has a conversation, otherwise let persistEntry() create the file later.
		if (hasConversation(state)) {
			rewriteSessionFile(state);
			state.flushed = true;
		} else {
			state.flushed = false;
		}

		if (previousSessionFile)
			recordFork(state.cwd, newSessionId, newSessionFile, { file: previousSessionFile, expectedId: previousSessionId });
		return newSessionFile;
	}

	// In-memory mode: replace current session with the path + labels
	rebuildIndex(state);
	return undefined;
}
