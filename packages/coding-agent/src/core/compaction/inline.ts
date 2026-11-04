import { renderInstruction } from "../prompt-template.ts";

/**
 * Text kept inline, cut to a budget, when a session has no file to save its complete text in (an in-memory,
 * `--no-session` session). The marker says what was left out, so the model does not mistake the cut for the whole.
 */

/**
 * `text` within `max` characters: its head and tail around a marker naming how much was omitted. Unchanged when it fits.
 * Not a duplicate of `clipText` or `truncateToWidth`, which keep only a head and end in `…`: this keeps both ends of a
 * text whose start and end both matter, and core cannot import the Octocode helpers.
 */
export function clipWithMarker(text: string, max: number): string {
	if (text.length <= max) return text;
	const marker = (omitted: number) => `\n${renderInstruction("notices/compaction/text-omitted.md", { omitted })}\n`;
	const room = Math.max(0, max - marker(text.length).length);
	const head = Math.ceil((room * 2) / 3);
	const tail = room - head;
	return `${text.slice(0, head)}${marker(text.length - room)}${tail > 0 ? text.slice(text.length - tail) : ""}`;
}
