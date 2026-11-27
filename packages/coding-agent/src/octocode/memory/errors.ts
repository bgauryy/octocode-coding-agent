import { AgentDbError, isBusy, writerErrorKind } from "../../../../db/src/api.ts";
import { memoryLabel } from "./query.ts";

/** A refused memory write or an id that is not visible in this scope. */
export class MemoryError extends Error {}

export const noMemory = (id: number): MemoryError =>
	new MemoryError(`No memory ${memoryLabel(id)} here (it may belong to another repository).`);

export class MemoryChangedError extends MemoryError {
	constructor(id: number) {
		super(`Memory ${memoryLabel(id)} changed; read it again before retrying the change.`);
	}
}

/** Called under the store's write reservation, against the revision the caller reviewed. */
export function checkRevision(memory: { id: number; updatedAt: number }, expected: number | undefined): void {
	if (expected !== undefined && memory.updatedAt !== expected) throw new MemoryChangedError(memory.id);
}

/**
 * A store that cannot serve now, which a caller may outlast: the agent database is missing, corrupt, retired or busy,
 * or its writer refused or stopped. Anything else is a defect and propagates to the log.
 */
export const storeUnavailable = (error: unknown): boolean =>
	error instanceof AgentDbError || isBusy(error) || writerErrorKind(error) !== undefined;
