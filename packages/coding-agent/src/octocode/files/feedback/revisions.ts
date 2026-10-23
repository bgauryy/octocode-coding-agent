import { randomUUID } from "node:crypto";

/** In-process revisions of file-tool commits, scoped to the active session identity. */
const revisions = new Map<string, number>();
/** Distinguishes a fresh host process from a resumed session with a reset in-memory counter. */
export const mutationEpoch = randomUUID();

export function currentMutationRevision(sessionId: string): number {
	return revisions.get(sessionId) ?? 0;
}

/** Called once at the filesystem commit boundary, including committed operations whose later cleanup fails. */
export function recordMutation(sessionId: string): number {
	const revision = currentMutationRevision(sessionId) + 1;
	revisions.set(sessionId, revision);
	return revision;
}
