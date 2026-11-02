/** Shared by every gate; unknown operations are never classified as reads. */
export function archiveMutation(input: Record<string, unknown>): boolean {
	return input.op === "set" || input.op === "delete";
}

export function archiveRead(input: Record<string, unknown>): boolean {
	return input.op === undefined || input.op === "list" || input.op === "search" || input.op === "get";
}
