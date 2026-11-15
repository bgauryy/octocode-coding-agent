import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { ExtensionContext } from "../../core/features/index.ts";
import { storedText } from "../../../../common/src/sanitize.ts";
import { clipText, textResult } from "../shared/util.ts";
import { SESSION_NOTE_BODY_MAX } from "./limits.ts";
import { MemoryError, MEMORY_KINDS, type MemoryKind, refuseMemorySecrets } from "./store.ts";
import {
	noteLabel,
	noteList,
	type NoteFold,
	type SessionNote,
	SESSION_NOTE_TYPE,
	type SessionNoteData,
	sessionNotes,
} from "./session-notes.ts";

/** The `memory` tool's session-note operations: the notes of the session `ctx` belongs to (`session-notes.ts`). */

/** What a write to a session note asks of the session: appending its entry. */
export type AppendEntry = (customType: string, data?: unknown) => void;

const TITLE_MAX = 200;
/** Longest search pattern: a model-written regular expression stays short enough to be cheap. */
const QUERY_MAX = 200;
/** Characters of a body on a list or search line. */
const PREVIEW_CHARS = 160;

interface NoteDetails {
	mode?: "search" | "get" | "list";
	hits?: number;
	ids?: number[];
	/** The notes whose whole text this result shows, by version: while it is in context the notes need no injection. */
	sessionNotes: Array<{ id: number; version: number }>;
}

export type NoteResult = ReturnType<typeof textResult<NoteDetails>>;

const shown = (...notes: SessionNote[]) => notes.map(({ id, version }) => ({ id, version }));

/** `S3 (session, decision) Title — body` on one line; a body over `bodyChars` is cut and the line ends with the call that reads it whole. */
function noteSummary(note: SessionNote, bodyChars = Number.POSITIVE_INFINITY): string {
	const body = note.body.replace(/\s+/g, " ").trim();
	const cut = body.length > bodyChars;
	const text = clipText(body, bodyChars);
	const head = `${noteLabel(note.id)} (session, ${note.kind}) ${note.title.replace(/\s+/g, " ")}`;
	return `${head}${text ? ` — ${text}` : ""}${cut ? ` (memory op=get id=${noteLabel(note.id)})` : ""}`;
}

function noteOf(fold: NoteFold, id: number): SessionNote {
	const note = fold.notes.get(id);
	if (!note)
		throw new MemoryError(
			`No session note ${noteLabel(id)}: session notes are per session; list them with scope "session".`,
		);
	return note;
}

/** The session and, when known, the model whose window sizes the note limits. */
type NoteContext = Pick<ExtensionContext, "sessionManager"> & { model?: { contextWindow?: number } | undefined };

interface SaveCall {
	ctx: NoteContext;
	append: AppendEntry | undefined;
	/** The note to update; undefined for a new one. */
	id: number | undefined;
	params: { title?: string | undefined; body?: string | undefined; kind?: MemoryKind | undefined };
}

function appendNote(append: AppendEntry | undefined, data: Omit<SessionNoteData, "version" | "at">): void {
	if (!append) throw new Error("Session notes are not available here.");
	append(SESSION_NOTE_TYPE, { version: 1, ...data, at: Date.now() } satisfies SessionNoteData);
}

/** Saves a new session note or a new version of one. Refusals come before anything is written. */
export function saveNote({ ctx, append, id, params }: SaveCall): NoteResult {
	const fold = sessionNotes(ctx.sessionManager);
	const current = id === undefined ? undefined : noteOf(fold, id);
	const title = params.title === undefined ? undefined : storedText(params.title, TITLE_MAX);
	const body = params.body === undefined ? undefined : storedText(params.body);
	refuseMemorySecrets({ title, body });
	if (!current && !title) throw new MemoryError("A new session note needs a title.");
	if (title === "") throw new MemoryError("A session note needs a title.");
	const bodyMax = SESSION_NOTE_BODY_MAX;
	if ((body ?? current?.body ?? "").length > bodyMax)
		throw new MemoryError(
			`A session note body is at most ${bodyMax} characters: keep the constraint, not its history.`,
		);
	if (params.kind !== undefined && !MEMORY_KINDS.includes(params.kind))
		throw new MemoryError(`Unknown kind ${params.kind}.`);
	const noteId = current?.id ?? fold.lastId + 1;
	appendNote(append, {
		op: "set",
		id: noteId,
		...(title !== undefined ? { title } : {}),
		...(body !== undefined ? { body } : {}),
		...(params.kind ? { kind: params.kind } : {}),
	});
	const note: SessionNote = {
		id: noteId,
		version: (current?.version ?? 0) + 1,
		title: title ?? current?.title ?? "",
		body: body ?? current?.body ?? "",
		kind: params.kind ?? current?.kind ?? "fact",
		at: Date.now(),
	};
	return textResult<NoteDetails>(`${current ? "Updated" : "Saved"} ${noteSummary(note)}`, {
		ids: [],
		sessionNotes: shown(note),
	});
}

/** Removes a session note (no approval: nothing outlives the session). */
export function deleteNote(ctx: NoteContext, append: AppendEntry | undefined, id: number): NoteResult {
	const note = noteOf(sessionNotes(ctx.sessionManager), id);
	appendNote(append, { op: "delete", id });
	return textResult<NoteDetails>(`Deleted ${noteSummary(note, PREVIEW_CHARS)}`, { ids: [], sessionNotes: [] });
}

/** The whole note `id` names. */
export function getNote(ctx: NoteContext, id: number): NoteResult {
	const note = noteOf(sessionNotes(ctx.sessionManager), id);
	return textResult<NoteDetails>(noteSummary(note), { mode: "get", hits: 1, sessionNotes: shown(note) });
}

/** The note `id` names as the write path's parameters, to promote it, and the call that removes it once that write succeeded. */
export function noteForPromotion(ctx: NoteContext, id: number): SessionNote {
	return noteOf(sessionNotes(ctx.sessionManager), id);
}

/** The case-insensitive pattern a search `query` names; a pattern that is not a valid regular expression, or is too long, is the caller's error. */
function noteFilter(query: string | undefined): RegExp | undefined {
	const pattern = query?.trim();
	if (!pattern) return undefined;
	if (pattern.length > QUERY_MAX)
		throw new MemoryError(`The query is a regular expression of at most ${QUERY_MAX} characters.`);
	try {
		return new RegExp(pattern, "i");
	} catch (error) {
		throw new MemoryError(`The query is not a valid regular expression: ${errorMessage(error)}`);
	}
}

/** The session notes a list (all of them) or a search (`query` regex, or `keywords` by word overlap) shows, at most `limit`. */
export function readNotes(
	ctx: NoteContext,
	params: { query?: string | undefined; keywords?: string | undefined; limit?: number | undefined },
): { text: string; hits: number } {
	const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 10)));
	const filter = noteFilter(params.query);
	const words = params.keywords?.trim() ? params.keywords.toLowerCase().split(/\s+/).filter(Boolean) : [];
	const scored = noteList(sessionNotes(ctx.sessionManager)).flatMap((note) => {
		const text = `${note.title}\n${note.body}`;
		if (filter && !filter.test(text)) return [];
		const lower = text.toLowerCase();
		const overlap = words.filter((word) => lower.includes(word)).length;
		return words.length > 0 && overlap === 0 ? [] : [{ note, overlap }];
	});
	if (words.length > 0) scored.sort((a, b) => b.overlap - a.overlap || a.note.id - b.note.id);
	const found = scored.slice(0, limit);
	const more = scored.length > found.length ? `\n(${scored.length - found.length} more: narrow the query)` : "";
	return {
		text: `session notes: ${found.length} matches\n${found.map(({ note }) => noteSummary(note, PREVIEW_CHARS)).join("\n")}${more}`,
		hits: found.length,
	};
}
