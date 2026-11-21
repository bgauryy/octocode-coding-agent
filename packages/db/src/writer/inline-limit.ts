import type { DbWriterCommand } from "./derived.ts";

/**
 * The most transcript text (characters of stored lines) one command may carry on the calling thread. A save or append
 * past it would block input and rendering for as long as it takes to write; it fails instead, and the worker
 * (another process, a restart) brings the copy level later.
 */
export const INLINE_TRANSCRIPT_LIMIT = 4 * 1024 * 1024;

/** Characters of transcript lines `command` stores; 0 for commands that carry none. */
export function transcriptChars(command: DbWriterCommand): number {
	let chars = 0;
	if (command.kind === "save") {
		chars = command.header.length;
		for (const record of command.records) chars += record.json.length;
	} else if (command.kind === "sync") {
		chars = command.header?.length ?? 0;
		for (const entry of command.entries ?? []) chars += entry.record.json.length;
	}
	return chars;
}
