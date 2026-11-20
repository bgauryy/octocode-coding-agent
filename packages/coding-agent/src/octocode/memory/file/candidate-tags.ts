import type { Memory } from "../record.ts";

/**
 * How a note in the database is marked as a lesson candidate (`candidates.ts`): by a keyword tag, so the database needs
 * no new column. A leaf, so the store, recall and the file sync can leave candidates out without importing the queue.
 */

/** A candidate a reflection or consolidation pass may use (`reflect.ts`). */
export const CANDIDATE_TAG = "memory-candidate";
/** A candidate drawn from text the session read from outside (web, MCP, another repository): never shown to a pass. */
export const QUARANTINE_TAG = "memory-quarantined";

const tags = (memory: Pick<Memory, "keywords">): string[] => memory.keywords.split(/\s+/);

/** Whether a note is a queued candidate, pending or quarantined, rather than a note someone saved. */
export const isCandidate = (memory: Pick<Memory, "keywords">): boolean =>
	tags(memory).some((tag) => tag === CANDIDATE_TAG || tag === QUARANTINE_TAG);

export const isQuarantined = (memory: Pick<Memory, "keywords">): boolean => tags(memory).includes(QUARANTINE_TAG);
