import { randomUUID } from "node:crypto";

/** In-process revisions of workspace mutations (file-tool commits and mutating shell commands), scoped to the active session identity. */
const revisions = new Map<string, number>();
/** How many of those were file-tool commits: edits the agent wrote itself, which a run must be able to show it checked. */
const fileCommits = new Map<string, number>();
/** The revision at which the newest passing verification receipt launched. */
const passing = new Map<string, number>();
/** Distinguishes a fresh host process from a resumed session with a reset in-memory counter. */
export const mutationEpoch = randomUUID();

export function currentMutationRevision(sessionId: string): number {
	return revisions.get(sessionId) ?? 0;
}

/**
 * Called once at the filesystem commit boundary, including committed operations whose later cleanup fails. A `bash`
 * command the shell guard classifies as changing the workspace passes `"bash"`: it makes receipts stale like an edit, but
 * is not counted as a file edit.
 */
export function recordMutation(sessionId: string, source: "file" | "bash" = "file"): number {
	const revision = currentMutationRevision(sessionId) + 1;
	revisions.set(sessionId, revision);
	if (source === "file") fileCommits.set(sessionId, fileEditCount(sessionId) + 1);
	return revision;
}

/** File-tool commits in this session so far. */
export function fileEditCount(sessionId: string): number {
	return fileCommits.get(sessionId) ?? 0;
}

/** A verification receipt that exited 0 with no mutation since its launch. */
export function recordPassingCheck(sessionId: string, revisionAtLaunch: number): void {
	passing.set(sessionId, revisionAtLaunch);
}

/** Whether a passing receipt exists for the current state: nothing changed the workspace since it launched. */
export function checkedAtCurrentRevision(sessionId: string): boolean {
	return passing.get(sessionId) === currentMutationRevision(sessionId);
}
