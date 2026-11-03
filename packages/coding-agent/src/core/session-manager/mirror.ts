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

type Update = "open" | "replace" | { previousSize: number; previousMtime: string; entry: SessionEntry };

/**
 * JSONL has already committed under its writer lock. A missed SQLite commit is repaired on the next append
 * or open. A current mirror needs no write on open and only one new row on append.
 */
export function mirrorTranscript(state: SessionState, sessionFile: string, mode: Update): void {
	const file = canonicalPath(sessionFile);
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
			withSessionFileLock(file, () => syncTranscript(agent, state, file, mode));
		} else syncTranscript(agent, state, file, mode);
		state.mirrorProblem = undefined;
	} catch (error) {
		const problem = errorMessage(error);
		if (state.mirrorProblem !== problem)
			process.stderr.write(`Session saved to ${file}. Database mirror pending: ${problem}\n`);
		state.mirrorProblem = problem;
	}
}

function syncTranscript(agent: AgentDb, state: SessionState, file: string, mode: Update): void {
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
		return;

	const delta =
		typeof mode === "object" &&
		previous?.file === file &&
		previous.file_binding === stat.binding &&
		previous.byte_size === mode.previousSize &&
		previous.mtime === mode.previousMtime;
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
			delta ? state.fileEntries.length - 2 : 0,
			previous?.file,
		);
	});
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
		process.stderr.write(`Could not record the fork origin for ${id}: ${errorMessage(error)}\n`);
	}
}
