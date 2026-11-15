import { renderInstruction } from "../../core/prompt-template.ts";
import { type Injection, MEMORY_HEADER, MEMORY_HEADER_AGAIN, quotedLine } from "./inject.ts";
import { noteLabel, notesOutOfContext, type NoteFold, type SessionNote } from "./session-notes.ts";

/** Characters of session-note lines per injection, apart from the memories' own budget: notes the model cannot see yet come first. */
const SESSION_BUDGET = 1600;

/** One note on one line, as a memory line is: label, tags, `(agent-written)`, then the quoted title and body. No age, so the bytes depend on the note alone. */
function noteLine(note: SessionNote): string {
	return quotedLine(
		`${noteLabel(note.id)} (session, ${note.kind}) (agent-written) `,
		note.title,
		note.body,
		`memory op=get id=${noteLabel(note.id)}`,
	);
}

/**
 * The lines of the session notes the model's context does not show, in id order within `SESSION_BUDGET`, and the held-back
 * note naming the call that lists the rest. Empty when every note is in context: such a turn adds no bytes. The notes that
 * do not fit stay out of context, so the next prompt carries them.
 */
export function sessionNoteLead(fold: NoteFold): { lines: string[]; notes: Array<{ id: number; version: number }> } {
	const lines: string[] = [];
	const notes: Array<{ id: number; version: number }> = [];
	const missing = notesOutOfContext(fold);
	let used = 0;
	for (const note of missing) {
		const line = noteLine(note);
		if (used + line.length + 1 > SESSION_BUDGET) continue;
		lines.push(line);
		notes.push({ id: note.id, version: note.version });
		used += line.length + 1;
	}
	const heldBack = missing.length - notes.length;
	if (heldBack > 0)
		lines.push(renderInstruction("notices/memory-session-held-back.md", { count: heldBack, several: heldBack !== 1 }));
	return { lines: notes.length > 0 ? lines : [], notes };
}

/** The message for session notes alone (memory recall is off, found nothing, or its store failed): the caveat, then the notes. */
export function noteOnlyInjection(lead: ReturnType<typeof sessionNoteLead>, headerInContext: boolean): Injection {
	const header = headerInContext ? MEMORY_HEADER_AGAIN : MEMORY_HEADER;
	return { content: [header, ...lead.lines].join("\n"), ids: [], updated: [], sessionNotes: lead.notes };
}
