import { getCapabilities, hyperlink, type Keybinding, truncateToWidth } from "@octocodeai/octocode-tui";
import { ITEM_REF, itemLinkUrl, itemLinksClickable } from "../item-ref.ts";
import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";
import { clip, plural, queryTarget } from "../../../../../common/src/clip.ts";
import { shortcutText } from "../keys.ts";

export { clip, plural, queryTarget };

export const GUTTER = "  ⎿  ";
export const INDENT = "     ";

/** The configured tool-output expansion key. */
export function expandKey(): string {
	return appKey("app.tools.expand");
}

/** Compact shortcut text, including an explicit unbound state. */
export function appKey(action: Keybinding): string {
	return shortcutText(action);
}

/** Fewest words a model-given reason needs to say anything the row's title does not (`Edit` alone does not; `Run tests` does). */
const REASON_MIN_WORDS = 2;

/** Whether a call's `reason` carries information worth a `↳` line. */
export function isInformativeReason(reason: string | undefined): reason is string {
	return reason !== undefined && reason.trim().split(/\s+/).length >= REASON_MIN_WORDS;
}

/** A multi-line message (an error that lists what was wrong) as one line, for a summary that `clip` would cut at its first line. */
export function oneLine(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.join(" ");
}

/** The SGR reset `truncateToWidth` wraps around its ellipsis; a sanitized line holds no other escape sequence. */
const TRUNCATION_RESET = /\x1b\[0m/g;

/**
 * One sanitized line of at most `max` terminal columns (a wide character counts 2), ending in `…` when cut: `clip` for
 * lines that must not wrap. The cut is the TUI's `truncateToWidth`, without its resets: a caller styles the line, and a
 * reset in it would end that style before the ellipsis.
 */
export function clipColumns(text: string, max: number): string {
	if (max <= 0) return "";
	const line = clip(text, Number.MAX_SAFE_INTEGER);
	return truncateToWidth(line, max, "…").replace(TRUNCATION_RESET, "");
}

/** `text` as display rows: terminal controls stripped, tabs widened, blank rows at both ends dropped. */
export function bodyLines(text: string): string[] {
	const rows = sanitizeTerminalText(text).replace(/\t/g, "   ").split("\n");
	while (rows.length > 0 && rows.at(-1)!.trim() === "") rows.pop();
	while (rows.length > 0 && rows[0].trim() === "") rows.shift();
	return rows;
}

/**
 * `text` as an OSC 8 link to backlog item `ref` where the terminal supports hyperlinks and something handles the click
 * (fullscreen mode with a `/web item` handler); the unchanged text elsewhere, so no link opens a dead page.
 */
export function linkItem(
	text: string,
	ref: string,
	enabled: boolean = getCapabilities().hyperlinks && itemLinksClickable(),
): string {
	return enabled && ITEM_REF.test(ref) ? hyperlink(text, itemLinkUrl(ref)) : text;
}
