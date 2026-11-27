/** Shared by every gate; unknown operations are never classified as reads. */
export function archiveRead(input: Record<string, unknown>): boolean {
	return input.op === undefined || input.op === "list" || input.op === "search" || input.op === "get";
}

/** A `memory` call that changes the store. */
export function memoryMutation(input: Record<string, unknown>): boolean {
	return input.op === "set" || input.op === "delete";
}

/** A `memory` call that only reads. `op` is required there, so a call without one is not a read. */
export function memoryRead(input: Record<string, unknown>): boolean {
	return input.op === "list" || input.op === "search" || input.op === "get";
}

/**
 * The `memory` operation a recorded `archive` call meant, from before the two tools split: `set` and `delete` only ever
 * acted on memories, `source: "memories"` read them, and an `M<n>` id named one. Undefined for a call `archive` answers.
 */
export function formerMemoryOp(input: Record<string, unknown>): string | undefined {
	if (input.op === "set" || input.op === "delete") return input.op;
	const memoryId = typeof input.id === "string" && /^M\d+$/.test(input.id);
	if (input.source !== "memories" && !(memoryId && input.source === undefined)) return undefined;
	if (typeof input.op === "string") return input.op;
	return input.id ? "get" : input.query || input.keywords ? "search" : "list";
}
