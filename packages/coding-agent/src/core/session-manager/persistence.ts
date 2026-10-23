import { appendFileSync, existsSync, mkdirSync, statSync } from "fs";
import { APP_NAME } from "../../config.ts";
import { atomicWriteFileSync } from "../../utils/atomic-file.ts";
import { resolvePath } from "../../utils/paths.ts";
import {
	assertValidSessionId,
	createSessionHeader,
	createSessionId,
	getSessionFilePath,
	migrateToCurrentVersion,
} from "./entries.ts";
import { getBranchEntries, type SessionState } from "./state.ts";
import { assertCompleteSessionTail, loadEntriesFromFile, writeNewSessionFile } from "./storage.ts";
import { buildBranchedEntries, indexSessionEntries } from "./tree.ts";
import { CURRENT_SESSION_VERSION, type FileEntry, type NewSessionOptions, type SessionEntry } from "./types.ts";

/** Create the session directory when persisting, then open the session file, load preloaded entries or start a new session. */
export function initializeSession(
	state: SessionState,
	sessionFile: string | undefined,
	newSessionOptions?: NewSessionOptions,
	preloadedFileEntries?: FileEntry[],
): void {
	if (state.persist && state.sessionDir && !existsSync(state.sessionDir)) {
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
	const resolvedFile = resolvePath(sessionFile);
	if (existsSync(resolvedFile)) {
		const entries = preloadedFileEntries ?? loadEntriesFromFile(resolvedFile);

		// If file was empty, initialize it with a valid session header. If it was
		// non-empty but did not parse as a pi session, fail without modifying it.
		if (entries.length === 0) {
			const explicitPath = resolvedFile;
			if (statSync(explicitPath).size > 0) {
				throw new Error(`Session file is not a valid ${APP_NAME} session: ${explicitPath}`);
			}
			startNewSession(state);
			state.sessionFile = explicitPath;
			rewriteSessionFile(state);
			state.flushed = true;
			return;
		}

		const header = entries.find((entry) => entry.type === "session");
		if ((header?.version ?? 1) < CURRENT_SESSION_VERSION) assertCompleteSessionTail(resolvedFile);
		state.sessionFile = resolvedFile;
		loadEntries(state, entries);
		state.flushed = true;
	} else {
		const explicitPath = resolvedFile;
		startNewSession(state);
		state.sessionFile = explicitPath; // preserve explicit path from --session flag
	}
	state.persistenceFailure = undefined;
}

export function startNewSession(state: SessionState, options?: NewSessionOptions): string | undefined {
	if (options?.id !== undefined) {
		assertValidSessionId(options.id);
	}
	state.sessionId = options?.id ?? createSessionId();
	const timestamp = new Date().toISOString();
	state.fileEntries = [createSessionHeader(state.sessionId, timestamp, state.cwd, options?.parentSession)];
	state.byId.clear();
	state.labelsById.clear();
	state.labelTimestampsById.clear();
	state.leafId = null;
	state.flushed = false;
	state.persistenceFailure = undefined;

	if (state.persist) {
		state.sessionFile = getSessionFilePath(state.sessionDir, timestamp, state.sessionId);
	}
	return state.sessionFile;
}

export function loadEntries(state: SessionState, entries: FileEntry[], options?: NewSessionOptions): void {
	const header = entries.find((e) => e.type === "session");

	if (header) {
		state.fileEntries = entries;
		state.sessionId = header.id;

		if (migrateToCurrentVersion(state.fileEntries)) {
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

export function rewriteSessionFile(state: SessionState): void {
	if (!state.persist || !state.sessionFile) return;
	atomicWriteFileSync(state.sessionFile, state.fileEntries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
}

/**
 * A new session file is created only once the session contains a user or assistant message.
 * Setup entries alone (model, thinking level, system prompt) stay in memory so opening and
 * closing pi without chatting leaves no file behind. Starting at the user message (not the
 * first assistant reply) keeps the prompt on disk if the first turn never completes (#10000).
 */
function hasConversation(state: SessionState): boolean {
	return state.fileEntries.some(
		(e) => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"),
	);
}

export function persistEntry(state: SessionState, entry: SessionEntry): void {
	if (!state.persist || !state.sessionFile) return;
	if (state.persistenceFailure) throw state.persistenceFailure;

	if (!state.flushed) {
		if (!hasConversation(state)) return;
		writeNewSessionFile(state.sessionFile, state.fileEntries);
		state.flushed = true;
	} else {
		assertCompleteSessionTail(state.sessionFile);
		appendFileSync(state.sessionFile, `${JSON.stringify(entry)}\n`, { flush: true });
	}
}

/** Append an entry as the new leaf and persist it; a failed write rolls the entry back and blocks further writes. */
export function appendEntry(state: SessionState, entry: SessionEntry): void {
	if (state.persistenceFailure) throw state.persistenceFailure;
	const previousLeaf = state.leafId;
	state.fileEntries.push(entry);
	state.byId.set(entry.id, entry);
	state.leafId = entry.id;
	try {
		persistEntry(state, entry);
	} catch (error) {
		state.fileEntries.pop();
		state.byId.delete(entry.id);
		state.leafId = previousLeaf;
		state.persistenceFailure = new Error(
			`Session persistence failed: ${String(error)}. Further writes are blocked; reload or recover the transcript before continuing.`,
			{ cause: error },
		);
		throw state.persistenceFailure;
	}
}

/**
 * Replace the state with a new session containing only the path from root to the specified leaf.
 * Returns the new session file path, or undefined if not persisting.
 */
export function createBranchedSession(state: SessionState, leafId: string): string | undefined {
	const previousSessionFile = state.sessionFile;
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
	state.sessionId = newSessionId;
	if (state.persist) {
		state.sessionFile = newSessionFile;
		rebuildIndex(state);

		// Use the same rule as persistEntry(): write now if the branched path already
		// has a conversation, otherwise let persistEntry() create the file later.
		if (hasConversation(state)) {
			rewriteSessionFile(state);
			state.flushed = true;
		} else {
			state.flushed = false;
		}

		return newSessionFile;
	}

	// In-memory mode: replace current session with the path + labels
	rebuildIndex(state);
	return undefined;
}
