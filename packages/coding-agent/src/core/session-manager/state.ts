import { SessionCodec } from "./codec.ts";
import { branchPath, EntryIndex } from "./entry-index.ts";
import type { FileEntry, SessionEntry, SessionInfoEntry, SessionNameSource } from "./types.ts";

/**
 * Entry, label and leaf state of one `SessionManager`, shared with the modules that load,
 * persist and append to it. Only the manager and those modules hold a reference.
 */
export interface SessionState {
	sessionId: string;
	sessionFile: string | undefined;
	readonly sessionDir: string;
	/** `sessionDir` is only the opened file's own folder: no caller chose it (`mirror-scope.ts` reads this). */
	readonly sessionDirFromFile: boolean;
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
	/** Records kept in memory because another process held the lock past the wait; the retry or the next write saves them first. */
	readonly unwritten: SessionEntry[];
	fileEntries: FileEntry[];
	/** What the session file holds so far, for storing the next line against it (`codec.ts`). */
	codec: SessionCodec;
	byId: Map<string, SessionEntry>;
	labelsById: Map<string, string>;
	labelTimestampsById: Map<string, string>;
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

export function createSessionState(
	cwd: string,
	sessionDir: string,
	persist: boolean,
	sessionDirFromFile = false,
): SessionState {
	return {
		sessionId: "",
		sessionFile: undefined,
		sessionDir,
		sessionDirFromFile,
		cwd,
		persist,
		flushed: false,
		fileSize: undefined,
		persistenceFailure: undefined,
		unwritten: [],
		fileEntries: [],
		codec: new SessionCodec(),
		byId: new EntryIndex(),
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
	return branchPath(state.byId, startId ? state.byId.get(startId) : undefined);
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

/** Where the last name lookup stopped: the entry list it read, its length and last entry, and the latest name entry in it. */
interface InfoMark {
	entries: FileEntry[];
	length: number;
	tail: FileEntry | undefined;
	found: SessionInfoEntry | undefined;
}

const infoMarks = new WeakMap<SessionState, InfoMark>();

function latestSessionInfo(state: SessionState): SessionInfoEntry | undefined {
	// Walk entries in reverse, down to where the last lookup ended while the list only grew since (the same array, still
	// holding its last entry at the same place; an insert before it or a rollback moves or removes it). An unnamed
	// session otherwise walked the whole session on every footer sample. Reads fileEntries directly: getEntries() copies.
	const entries = state.fileEntries;
	const mark = infoMarks.get(state);
	const resumes =
		mark !== undefined &&
		mark.entries === entries &&
		entries.length >= mark.length &&
		mark.length > 0 &&
		entries[mark.length - 1] === mark.tail;
	const from = resumes ? mark.length : 0;
	let found = resumes ? mark.found : undefined;
	for (let i = entries.length - 1; i >= from; i--) {
		const entry = entries[i];
		if (entry.type === "session_info") {
			found = entry;
			break;
		}
	}
	infoMarks.set(state, { entries, length: entries.length, tail: entries[entries.length - 1], found });
	return found;
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
