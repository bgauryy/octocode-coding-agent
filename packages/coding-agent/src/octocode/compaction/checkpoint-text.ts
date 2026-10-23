import { CheckpointPersistenceError } from "../../core/compaction/checkpoint.ts";
import { clipWithMarker } from "../../core/compaction/inline.ts";
import { saveFullOutput } from "../shared/spill.ts";
import { contentText, isRecord } from "../shared/util.ts";
import { fullTextIn } from "./archive.ts";

/**
 * Text the summary cannot hold whole: a long tool result for the summarizer, the user's own messages in the summary.
 * It is saved to a file and replaced by a reference, or, when the session has no file to save to (an in-memory session,
 * `save` is `null`), kept inline, cut to its budget with a marker.
 */

/** Saves a text and returns where, or undefined when it could not be saved. */
export type SaveText = (text: string) => string | undefined;

export const USER_HEADING = "## User Messages (verbatim, oldest first)";

/** The user's own messages kept after the summary, newest first, up to about 15k to 20k tokens in all, at 4 to 3 characters per token (their words are the one record the summary cannot rebuild)... */
export const USER_MESSAGES_CHARS = 60_000;
/** A larger message moves whole to a persisted checkpoint reference instead of being cut (inline when the session has no file: cut with a marker). */
export const USER_MESSAGE_CHARS = 6_000;
/** Longer tool results are saved whole and represented by a bounded reference for the standalone summarizer (inline: cut with a marker). */
export const SUMMARIZER_RESULT_CHARS = 2_000;

/**
 * User text made inert inside the section: its own `<user-message>` tags and a line starting like the section heading
 * get a backslash, so a pasted summary or a quote of this feature cannot split or fake the section.
 */
export function inertUserText(text: string): string {
	return text
		.replace(/<(\/?)user-message>/g, "<\\$1user-message>")
		.replace(/^## User Messages/gm, "\\## User Messages");
}

function savedReference(text: string, save: SaveText): string {
	const file = save(text);
	if (!file) throw new CheckpointPersistenceError("Cannot persist complete compaction content.");
	return `[Complete text saved at ${file}; search it and read only relevant bounded line ranges for the original content.]`;
}

/** Keep whole messages or a reference to their complete persisted text, including inherited messages; inline and cut when `save` is null. */
export function userMessagesSection(
	earlier: readonly string[],
	omittedBefore: number,
	added: readonly string[],
	budget = { total: USER_MESSAGES_CHARS, perMessage: USER_MESSAGE_CHARS },
	segment?: number,
	save: SaveText | null = (text) => saveFullOutput(text, "checkpoint-user-messages"),
): string {
	const all = [...earlier, ...added.map(inertUserText)];
	if (all.length === 0) return "";
	const render = (messages: readonly string[], omitted: number, where = ` (${fullTextIn(segment, true)} has them)`) => {
		const note = omitted > 0 ? `\nEarlier user messages not kept here: ${omitted}${where}.` : "";
		return `\n\n${USER_HEADING}${note}\n${messages.map((text) => `<user-message>\n${text}\n</user-message>`).join("\n")}`;
	};
	const whole = render(all, omittedBefore);
	if (whole.length <= budget.total && all.every((message) => message.length <= budget.perMessage)) return whole;
	if (save === null) {
		// No file keeps the complete text: each message is cut to its share, and the oldest go first when the total is over.
		const kept = all.map((message) => clipWithMarker(message, budget.perMessage));
		let omitted = omittedBefore;
		while (kept.length > 0 && render(kept, omitted, "").length > budget.total) {
			kept.shift();
			omitted += 1;
		}
		return kept.length === 0 ? "" : render(kept, omitted, "");
	}
	const reference = savedReference(whole, save);
	const section = render([reference], omittedBefore);
	if (section.length > budget.total)
		throw new CheckpointPersistenceError("The user-message budget cannot hold a complete-text reference.");
	return section;
}

/** Save complete long tool results before replacing them with a summarizer reference; inline and cut when `save` is null. */
export function summarizerView<T>(
	messages: readonly T[],
	_segment?: number,
	save: SaveText | null = (text) => saveFullOutput(text, "checkpoint-tool-result"),
): T[] {
	return messages.map((message) => {
		if (!isRecord(message) || message.role !== "toolResult" || !Array.isArray(message.content)) return message;
		const content = message.content as unknown[];
		const text = contentText(content);
		if (text.length <= SUMMARIZER_RESULT_CHARS) return message;
		const shown = save === null ? clipWithMarker(text, SUMMARIZER_RESULT_CHARS) : savedReference(text, save);
		if (shown.length > SUMMARIZER_RESULT_CHARS)
			throw new CheckpointPersistenceError("The summarizer budget cannot hold a complete-text reference.");
		const others = content.filter((part) => !(isRecord(part) && part.type === "text"));
		return { ...message, content: [{ type: "text", text: shown }, ...others] };
	});
}
