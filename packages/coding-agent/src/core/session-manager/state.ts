import type { FileEntry, SessionEntry } from "./types.ts";

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
	fileEntries: FileEntry[];
	readonly byId: Map<string, SessionEntry>;
	readonly labelsById: Map<string, string>;
	readonly labelTimestampsById: Map<string, string>;
	leafId: string | null;
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
	const path: SessionEntry[] = [];
	const startId = fromId ?? state.leafId;
	let current = startId ? state.byId.get(startId) : undefined;
	while (current) {
		path.push(current);
		current = current.parentId ? state.byId.get(current.parentId) : undefined;
	}
	path.reverse();
	return path;
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

/** The current session name from the latest session_info entry, if any. */
export function getLatestSessionName(state: SessionState): string | undefined {
	// Walk entries in reverse to find the latest session_info entry.
	// Empty names explicitly clear the session title. Reads fileEntries directly: the footer
	// calls this on every frame, and getEntries() copies the whole session.
	for (let i = state.fileEntries.length - 1; i >= 0; i--) {
		const entry = state.fileEntries[i];
		if (entry.type === "session_info") {
			return entry.name?.trim() || undefined;
		}
	}
	return undefined;
}
