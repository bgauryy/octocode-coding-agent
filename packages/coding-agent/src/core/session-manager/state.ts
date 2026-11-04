import { pathFromRoot } from "./ancestors.ts";
import type { FileEntry, SessionEntry, SessionInfoEntry, SessionNameSource } from "./types.ts";

/**
 * Entry, label and leaf state of one `SessionManager`, shared with the modules that load,
 * persist and append to it. Only the manager and those modules hold a reference.
 */
export interface SessionState {
	sessionId: string;
	sessionFile: string | undefined;
	readonly sessionDir: string;
	readonly cwd: string;
	readonly persist: boolean;
	flushed: boolean;
	/** Byte size of the session file after this state's last load or write; undefined until the file is known. */
	fileSize: number | undefined;
	persistenceFailure: Error | undefined;
	/**
	 * Set when `persistenceFailure` came from the file system rather than from refusing the file's contents, so a later
	 * write may try again (`write-recovery.ts`). `line` and `entry` name the append it failed inside, which is what proves
	 * a torn tail is this process's own.
	 */
	failedWrite?: FailedWrite;
	/** Messages kept in memory because another process held the lock past the wait; the next write saves them first. */
	readonly unwritten: SessionEntry[];
	mirrorProblem?: string;
	/** After a failed mirror rebuild, when an append may try the next one and how many failed in a row. */
	mirrorRebuild?: { notBefore: number; failures: number };
	fileEntries: FileEntry[];
	readonly byId: Map<string, SessionEntry>;
	readonly labelsById: Map<string, string>;
	readonly labelTimestampsById: Map<string, string>;
	leafId: string | null;
}

/** What a failed write knew: the file's size before it and, inside an append, the line and entry it was writing. */
export interface FailedWrite {
	from: number | undefined;
	/** The file's size right after the failure: a later size means another writer has been here since. */
	after?: number;
	line?: string;
	entry?: SessionEntry;
}

export function createSessionState(cwd: string, sessionDir: string, persist: boolean): SessionState {
	return {
		sessionId: "",
		sessionFile: undefined,
		sessionDir,
		cwd,
		persist,
		flushed: false,
		fileSize: undefined,
		persistenceFailure: undefined,
		unwritten: [],
		fileEntries: [],
		byId: new Map(),
		labelsById: new Map(),
		labelTimestampsById: new Map(),
		leafId: null,
	};
}

/** All session entries (excludes header) as a shallow copy. */
export function getSessionEntries(state: SessionState): SessionEntry[] {
	return state.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
}

/** Walk from an entry (default: the leaf) to root, returning all entries in path order. */
export function getBranchEntries(state: SessionState, fromId?: string): SessionEntry[] {
	const startId = fromId ?? state.leafId;
	return pathFromRoot(startId ? state.byId.get(startId) : undefined, (id) => state.byId.get(id));
}

/** Get all direct children of an entry. */
export function getChildEntries(state: SessionState, parentId: string): SessionEntry[] {
	const children: SessionEntry[] = [];
	for (const entry of state.byId.values()) {
		if (entry.parentId === parentId) {
			children.push(entry);
		}
	}
	return children;
}

/** The latest session_info entry, if any. */
function latestSessionInfo(state: SessionState): SessionInfoEntry | undefined {
	// Walk entries in reverse. Reads fileEntries directly: the footer calls this on every frame, and getEntries()
	// copies the whole session.
	for (let i = state.fileEntries.length - 1; i >= 0; i--) {
		const entry = state.fileEntries[i];
		if (entry.type === "session_info") return entry;
	}
	return undefined;
}

/** The current session name from the latest session_info entry, if any. Empty names explicitly clear it. */
export function getLatestSessionName(state: SessionState): string | undefined {
	return latestSessionInfo(state)?.name?.trim() || undefined;
}

/** Who gave the current session name; undefined when there is no name. */
export function getLatestSessionNameSource(state: SessionState): SessionNameSource | undefined {
	const entry = latestSessionInfo(state);
	if (!entry?.name?.trim()) return undefined;
	return entry.source ?? "user";
}
