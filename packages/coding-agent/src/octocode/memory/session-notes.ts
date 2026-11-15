import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { CLEARED_RESULTS_TYPE } from "../shared/cleared-results.ts";
import { BranchIndex, type BranchSource } from "../shared/branch-index.ts";
import { contentText } from "../shared/util.ts";
import { MEMORY_MESSAGE_TYPE } from "./inject.ts";
import type { MemoryKind } from "./store.ts";

/**
 * Session notes: short notes one session keeps through its own compactions. They are `octocode-session-note` custom
 * entries in the session file (never sent to the model); the current set is a fold over the session's branch, so a
 * fork, a resume and `/tree` navigation see the notes of their branch. A note is shown to the model once in each stretch
 * of context: in the `memory` result that saved it, or in an `octocode-memory` injection (`inject.ts`) once a compaction,
 * a context edit or result clearing took that text out of the context.
 */
export const SESSION_NOTE_TYPE = "octocode-session-note";

/** The `S<n>` label of a note. */
export const noteLabel = (id: number): string => `S${id}`;

/** `S3`, `s3` → 3; anything else → undefined. */
export function parseNoteId(raw: string | undefined): number | undefined {
	const match = /^\s*s(\d{1,15})\s*$/i.exec(raw ?? "");
	const id = match ? Number(match[1]) : Number.NaN;
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export interface SessionNote {
	id: number;
	/** How many times this note was saved: an edit makes a new version, and a copy of the old text in context is stale. */
	version: number;
	title: string;
	body: string;
	kind: MemoryKind;
	at: number;
}

/** The data of one session-note entry. */
export interface SessionNoteData {
	version: 1;
	op: "set" | "delete";
	id: number;
	title?: string;
	body?: string;
	kind?: MemoryKind;
	at: number;
}

/** A message of the context that shows some notes: which versions, and what could take them out of the context. */
interface Carrier {
	/** The entry's position on the branch. */
	at: number;
	entryId: string | undefined;
	/** The tool call id of a `memory` result: result clearing names it. */
	callId: string | undefined;
	text: string;
	intact: boolean;
	notes: Array<{ id: number; version: number }>;
}

export interface NoteFold {
	/** How many entries the fold has read: the next entry's position. */
	read: number;
	readonly position: Map<string, number>;
	readonly notes: Map<number, SessionNote>;
	/** The highest id ever used, so an id is never reused in a session. */
	lastId: number;
	/** Position of the first entry a compaction kept: messages before it are summarized away. */
	floor: number;
	readonly carriers: Carrier[];
	/** Tool call ids of results the model sees as cleared placeholders. */
	readonly cleared: Set<string>;
}

const startFold = (): NoteFold => ({
	read: 0,
	position: new Map(),
	notes: new Map(),
	lastId: 0,
	floor: 0,
	carriers: [],
	cleared: new Set(),
});

function versions(value: unknown): Array<{ id: number; version: number }> {
	const list = asRecord(value).sessionNotes;
	if (!Array.isArray(list)) return [];
	return list.flatMap((item) =>
		isRecord(item) && typeof item.id === "number" && typeof item.version === "number"
			? [{ id: item.id, version: item.version }]
			: [],
	);
}

function foldEntry(fold: NoteFold, entry: unknown): void {
	const at = fold.read++;
	if (!isRecord(entry)) return;
	const entryId = typeof entry.id === "string" ? entry.id : undefined;
	if (entryId) fold.position.set(entryId, at);
	switch (entry.type) {
		case "compaction": {
			const kept = typeof entry.firstKeptEntryId === "string" ? fold.position.get(entry.firstKeptEntryId) : undefined;
			// An unknown kept entry keeps nothing: everything before the compaction is summarized.
			fold.floor = Math.max(fold.floor, kept ?? fold.read);
			return;
		}
		case "context_edit": {
			const target = fold.carriers.find((carrier) => carrier.entryId === entry.targetId);
			if (target)
				target.intact = entry.replacement !== null && contentText(asRecord(entry.replacement).content) === target.text;
			return;
		}
		case "custom": {
			if (entry.customType === CLEARED_RESULTS_TYPE) {
				const results = asRecord(entry.data).results;
				for (const result of Array.isArray(results) ? results : [])
					if (isRecord(result) && typeof result.id === "string") fold.cleared.add(result.id);
				return;
			}
			if (entry.customType === SESSION_NOTE_TYPE) applyNote(fold, asRecord(entry.data));
			return;
		}
		case "custom_message": {
			if (entry.customType !== MEMORY_MESSAGE_TYPE) return;
			const notes = versions(entry.details);
			if (notes.length > 0)
				fold.carriers.push({ at, entryId, callId: undefined, text: contentText(entry.content), intact: true, notes });
			return;
		}
		case "message": {
			const message = asRecord(entry.message);
			if (message.role !== "toolResult" || message.toolName !== "memory") return;
			const notes = versions(message.details);
			if (notes.length > 0)
				fold.carriers.push({
					at,
					entryId,
					callId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
					text: contentText(message.content),
					intact: true,
					notes,
				});
		}
	}
}

function applyNote(fold: NoteFold, data: Record<string, unknown>): void {
	const id = data.id;
	if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return;
	fold.lastId = Math.max(fold.lastId, id);
	if (data.op === "delete") {
		fold.notes.delete(id);
		return;
	}
	if (data.op !== "set") return;
	const before = fold.notes.get(id);
	const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
	fold.notes.set(id, {
		id,
		version: (before?.version ?? 0) + 1,
		title: text(data.title, before?.title ?? ""),
		body: text(data.body, before?.body ?? ""),
		kind: text(data.kind, before?.kind ?? "fact") as MemoryKind,
		at: typeof data.at === "number" ? data.at : (before?.at ?? 0),
	});
}

const noteIndex = new BranchIndex<NoteFold>(startFold, foldEntry);

/** The session's notes on its current branch: resumed from where the last read ended (`BranchIndex`). Read-only. */
export function sessionNotes(session: BranchSource): NoteFold {
	return noteIndex.read(session);
}

/** The notes in id order. */
export const noteList = (fold: NoteFold): SessionNote[] => [...fold.notes.values()].sort((a, b) => a.id - b.id);

/** Whether the model's context holds this version of `note`: a kept, unedited, uncleared message shows it. */
function inContext(fold: NoteFold, note: SessionNote): boolean {
	return fold.carriers.some(
		(carrier) =>
			carrier.at >= fold.floor &&
			carrier.intact &&
			!(carrier.callId !== undefined && fold.cleared.has(carrier.callId)) &&
			carrier.notes.some((shown) => shown.id === note.id && shown.version === note.version),
	);
}

/** The notes whose current version the model cannot see, in id order: what the next injection must carry. */
export function notesOutOfContext(fold: NoteFold): SessionNote[] {
	return noteList(fold).filter((note) => !inContext(fold, note));
}
