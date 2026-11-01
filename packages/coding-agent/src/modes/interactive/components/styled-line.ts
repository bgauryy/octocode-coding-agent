// One owner for status-row sanitizing, shared with octocode/ui (which may not import modes/).
import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";

export { styledLine } from "../../../../../common/src/sanitize.ts";

/**
 * Untrusted text (a message, label, command or file name) as one row: every terminal control, colours included, is
 * removed, and line breaks and tabs become spaces.
 */
export function plainText(text: string): string {
	return sanitizeTerminalText(text)
		.replace(/[\n\t]/g, " ")
		.trim();
}
