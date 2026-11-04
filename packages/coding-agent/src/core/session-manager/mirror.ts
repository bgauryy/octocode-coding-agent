import { getFileStamp } from "../../../../common/src/paths.ts";
import { existsSync, statSync } from "node:fs";
import { canonicalPath } from "../../../../common/src/canonical-path.ts";
import { type AgentDb, transcripts } from "../../../../db/src/api.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { sharedAgentDb } from "../../config/database.ts";
import { registeredWorkspace } from "../../config/workspace-database.ts";
import { readWorkspaceIdentity } from "../../config/workspace.ts";
import type { SessionState } from "./state.ts";
import { withSessionFileLock } from "./shared-file.ts";
import { loadEntriesFromFile } from "./storage.ts";
import type { SessionEntry } from "./types.ts";

let noticeHandler: ((message: string) => void) | undefined;

/**
 * Where a mirror problem is reported. Without a handler it goes to stderr; a full-screen UI sets one so the text does
 * not print over the screen. Returns the function that removes the handler.
 */
export function setMirrorNoticeHandler(handler: (message: string) => void): () => void {
	noticeHandler = handler;
	return () => {
		if (noticeHandler === handler) noticeHandler = undefined;
	};
}

function notify(message: string): void {
	if (noticeHandler) noticeHandler(message);
	else process.stderr.write(`${message}\n`);
}

type Update = "open" | "replace" | { previousSize: number; previousMtime: string; entry: SessionEntry };

/**
 * The wait before an append tries another full rebuild after one failed, doubling up to the last. A rebuild parses the
 * whole file on the main thread under the session lock, and the JSONL is already safe, so a database that stays busy
 * must not cost that on every append. An open or a replace still tries at once.
 */
const REBUILD_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

/**
 * JSONL has already committed under its writer lock. A missed SQLite commit is repaired on the next append
 * or open. A current mirror needs no write on open and only one new row on append.
 */
export function mirrorTranscript(state: SessionState, sessionFile: string, mode: Update): void {
	const file = canonicalPath(sessionFile);
	// A failed delta costs one row and repairs itself at the next append; only a failed rebuild waits before the next.
	const work = { rebuild: true };
	try {
		const agent = sharedAgentDb();
		if (mode === "open") {
			const previous = transcripts.stamp(agent.db, state.sessionId);
			const stat = getFileStamp(file);
			if (
				previous?.file === file &&
				previous.byte_size === stat.size &&
				previous.mtime === stat.mtime &&
				previous.file_binding === stat.binding
			) {
				workspaceForMirror(agent, state.cwd, previous.workspace_id, "open");
				return;
			}
			withSessionFileLock(file, () => syncTranscript(agent, state, file, mode, work));
		} else if (!syncTranscript(agent, state, file, mode, work)) return;
		state.mirrorProblem = undefined;
		state.mirrorRebuild = undefined;
	} catch (error) {
		const problem = errorMessage(error);
		if (state.mirrorProblem !== problem) notify(`Session saved to ${file}. Database mirror pending: ${problem}`);
		state.mirrorProblem = problem;
		if (work.rebuild) {
			const failures = (state.mirrorRebuild?.failures ?? 0) + 1;
			const wait = REBUILD_BACKOFF_MS[Math.min(failures, REBUILD_BACKOFF_MS.length) - 1];
			state.mirrorRebuild = { notBefore: Date.now() + wait, failures };
		}
	}
}

/** Bring the mirror level with the file; false when an append left a needed rebuild for after its backoff. */
function syncTranscript(
	agent: AgentDb,
	state: SessionState,
	file: string,
	mode: Update,
	work: { rebuild: boolean },
): boolean {
	const id = state.sessionId;
	const previous = transcripts.stamp(agent.db, id);
	const stat = getFileStamp(file);
	if (previous && previous.file !== file && (existsSync(previous.file) || previous.file_binding !== stat.binding)) {
		throw new Error("Another transcript already uses this session ID");
	}
	const workspaceId = workspaceForMirror(agent, state.cwd, previous?.workspace_id, mode);
	if (
		mode === "open" &&
		previous?.file === file &&
		previous.byte_size === stat.size &&
		previous.mtime === stat.mtime &&
		previous.file_binding === stat.binding
	)
		return true;

	const delta =
		typeof mode === "object" &&
		previous?.file === file &&
		previous.file_binding === stat.binding &&
		previous.byte_size === mode.previousSize &&
		previous.mtime === mode.previousMtime;
	work.rebuild = !delta;
	if (typeof mode === "object" && !delta && Date.now() < (state.mirrorRebuild?.notBefore ?? 0)) return false;
	// An open can race an append before obtaining the lock. Re-read a changed file while locked.
	const records = mode === "replace" || delta ? state.fileEntries : loadEntriesFromFile(file);
	const header = records[0];
	if (header?.type !== "session" || header.id !== id) throw new Error("Session file identity changed");
	const entries = delta ? [mode.entry] : records.filter((entry): entry is SessionEntry => entry.type !== "session");
	agent.transaction(() => {
		if (!previous?.workspace_id || previous.file !== file) transcripts.bind(agent.db, id, workspaceId ?? null);
		transcripts.save(
			agent.db,
			id,
			file,
			header,
			stat,
			entries,
			// Its index among the entries, past the header (not always the last: held entries are written in a row).
			delta ? state.fileEntries.lastIndexOf(mode.entry) - 1 : 0,
			previous?.file,
		);
	});
	return true;
}

/** Opening an imported transcript can resolve an existing declaration but must never create one at its header cwd. */
function workspaceForMirror(
	agent: AgentDb,
	cwd: string,
	bound: string | null | undefined,
	mode: Update,
): string | null {
	const identity = readWorkspaceIdentity(cwd);
	if (bound && bound !== identity?.id) throw new Error("Transcript belongs to a different or unavailable workspace");
	if (identity) return registeredWorkspace(identity, agent).id;
	return mode !== "open" && statSync(cwd, { throwIfNoEntry: false })?.isDirectory()
		? registeredWorkspace(cwd, agent).id
		: null;
}

/** Call only for an explicitly created fork, never for parentSession data loaded from a transcript file. */
export function recordFork(
	cwd: string,
	id: string,
	file: string,
	source: { file: string; expectedId?: string } | { storedId: string },
): void {
	try {
		const agent = sharedAgentDb();
		// A stored ID came from SQLite. Its historical path is descriptive and is never resolved or opened.
		const parent =
			"storedId" in source ? source.storedId : transcripts.fileOwner(agent.db, canonicalPath(source.file))?.id;
		if (!parent || ("expectedId" in source && source.expectedId !== parent)) return;
		const workspace = registeredWorkspace(cwd, agent);
		agent.transaction(() => {
			transcripts.bind(agent.db, id, workspace.id);
			transcripts.linkFork(agent.db, id, canonicalPath(file), parent);
		});
	} catch (error) {
		notify(`Could not record the fork origin for ${id}: ${errorMessage(error)}`);
	}
}
