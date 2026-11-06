import type { AskView } from "../../shared/ask-view.ts";
import { cardLines, foldLines } from "../effect.ts";
import type { PermissionMode } from "../mode.ts";
import type { PermissionRequest } from "../request.ts";

const AGENT_SAYS = "agent says (unverified):";
/** Rows of a target (a command, the first paths) the collapsed card shows; `tab` shows the rest. */
const TARGET_PREVIEW = 2;

/** What each fixed choice does, under its label in the card. */
const DESCRIPTIONS = {
	once: "only this one; the next one asks again",
	session: "later ones like it run unasked until this session ends",
	kind: "every one of this kind runs unasked until this session ends",
	deny: "the agent is told you refused",
	note: "type what to do instead; esc returns here",
};

interface Labels {
	allowOnce: string;
	session?: string;
	kind?: string;
	deny: string;
	note: string;
	noteTitle: string;
}

/**
 * The prompt as an ask card: the title as its question, a message's sender as metadata and its text as a collapsible body
 * (`request.view`), or else the targets as a body that never collapses (nothing runs that was not on screen); the effect
 * card as its details; the choices with what each does, and "Deny and tell the agent why…" as the write-in row.
 * Every line comes from the same text the plain title shows.
 */
export function permissionView(
	request: PermissionRequest,
	mode: PermissionMode,
	choices: readonly string[],
	labels: Labels,
): AskView {
	const described: Record<string, string> = {
		[labels.allowOnce]: DESCRIPTIONS.once,
		...(labels.session ? { [labels.session]: DESCRIPTIONS.session } : {}),
		...(labels.kind ? { [labels.kind]: DESCRIPTIONS.kind } : {}),
		[labels.deny]: DESCRIPTIONS.deny,
		[labels.note]: DESCRIPTIONS.note,
	};
	const lines = cardLines(request, mode, "").map((line) => {
		const text = line.replace(/^▸ /, "");
		return { text, tone: text.startsWith("risk:") ? ("warning" as const) : ("muted" as const) };
	});
	const notes = lines.filter((note) => !note.text.startsWith(AGENT_SAYS));
	const body = request.view
		? { text: request.view.body, collapsible: true, previewLines: TARGET_PREVIEW }
		: request.what.length
			? { text: request.what.map(foldLines).join("\n"), collapsible: true, previewLines: TARGET_PREVIEW }
			: undefined;
	// The call's own reason, one dim line: the same text the title's `agent says (unverified)` line carries.
	const agent = lines.find((note) => note.text.startsWith(AGENT_SAYS));
	const meta = [...(request.view?.meta.map(foldLines) ?? []), ...(agent ? [agent.text] : [])];
	return {
		question: request.title,
		...(meta.length ? { meta } : {}),
		...(body ? { body } : {}),
		...(notes.length ? { notes } : {}),
		options: choices.map((label) => ({
			label,
			...(described[label] ? { description: described[label] } : {}),
			...(label === labels.deny ? { tone: "danger" as const } : {}),
		})),
		writeIn: { label: labels.note, title: labels.noteTitle, placeholder: "what to do instead" },
	};
}
