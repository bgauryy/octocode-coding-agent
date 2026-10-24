import type { SystemMessage } from "../types.ts";
import { contentText } from "./text.ts";

/**
 * Splits a leading system message into a base block and a project block at the named section, for adapters that
 * mark both blocks as instruction cache breakpoints. The base block holds the content and every section before the
 * boundary; the project block holds the boundary section and every later one. The base block ends with the "\n\n"
 * joiner, so the two blocks concatenate to exactly `getSystemMessageText(message)`.
 *
 * Returns undefined, meaning "send one block", when there is no boundary, the boundary names no section with
 * text, or nothing precedes it (an opaque prompt without sections never splits).
 */
export function splitSystemMessageAtBoundary(
	message: SystemMessage,
	boundary: string | undefined,
): [base: string, project: string] | undefined {
	if (!boundary || !message.sections) return undefined;
	const base: string[] = [contentText(message.content)];
	const project: string[] = [];
	let reached = false;
	for (const [name, text] of Object.entries(message.sections)) {
		if (name === boundary) reached = true;
		if (text === null) continue;
		(reached ? project : base).push(text);
	}
	const baseText = base.filter((part) => part.length > 0).join("\n\n");
	const projectText = project.filter((part) => part.length > 0).join("\n\n");
	if (baseText.length === 0 || projectText.length === 0) return undefined;
	return [`${baseText}\n\n`, projectText];
}
