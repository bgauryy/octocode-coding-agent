import { isDeepStrictEqual } from "node:util";
import type { SessionState } from "./state.ts";
import type { FileEntry, SessionEntry } from "./types.ts";

/** A producer can reserve a transcript ID and track when the session has written that entry. */
export interface EntryReceipt {
	entryId: string;
	recorded(): void;
}

const pending = new WeakMap<FileEntry, EntryReceipt[]>();

export function trackEntry(entry: FileEntry, receipt: EntryReceipt): void {
	pending.set(entry, [receipt]);
}

/** Run outside the transcript's file lock. The producer may write its own durable cursor. */
export function entryWritten(entry: FileEntry): void {
	const receipts = pending.get(entry);
	if (!receipts) return;
	pending.delete(entry);
	queueMicrotask(() => {
		for (const receipt of receipts) receipt.recorded();
	});
}

/** A first user prompt, assistant reply or durable completion materializes an otherwise empty session. */
export function needsTranscript(entries: readonly FileEntry[]): boolean {
	return entries.some(
		(entry) =>
			pending.has(entry) ||
			(entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")),
	);
}

function verifyReceipt(entry: SessionEntry, existing: SessionEntry): void {
	if (
		entry.type !== "custom_message" ||
		existing.type !== "custom_message" ||
		entry.customType !== existing.customType ||
		!isDeepStrictEqual(entry.content, existing.content)
	) {
		throw new Error(`Transcript receipt ${entry.id} conflicts with an existing entry`);
	}
}

/** A retry may find the reserved ID already in memory, including in a write still waiting for the file lock. */
export function joinReceipt(entry: SessionEntry, existing: SessionEntry, receipt: EntryReceipt): void {
	verifyReceipt(entry, existing);
	const receipts = pending.get(existing);
	if (receipts) receipts.push(receipt);
	else receipt.recorded();
}

/** A session rebind can find a receipt still queued behind another process's file lock. */
export function pendingEntryWrite(entry: SessionEntry): Promise<void> | undefined {
	const receipts = pending.get(entry);
	if (receipts) return new Promise((resolve) => receipts.push({ entryId: entry.id, recorded: resolve }));
	return undefined;
}

/** The file lock revealed that another writer already delivered this same reserved entry. Keep the canonical record. */
export function adoptWrittenReceipt(
	state: SessionState,
	entry: SessionEntry,
	existing: SessionEntry,
	queued: SessionEntry[],
): boolean {
	if (!pending.has(entry)) return false;
	verifyReceipt(entry, existing);
	state.fileEntries.splice(state.fileEntries.lastIndexOf(entry), 1);
	if (entry.parentId !== existing.parentId) {
		// Each writer stays on its own branch when the other delivered the result on a different branch.
		if (state.leafId === entry.id) state.leafId = entry.parentId;
		for (const child of queued) if (child.parentId === entry.id) child.parentId = entry.parentId;
	}
	const held = state.unwritten.indexOf(entry);
	if (held >= 0 && state.unwritten !== queued) state.unwritten.splice(held, 1);
	entryWritten(entry);
	return true;
}
