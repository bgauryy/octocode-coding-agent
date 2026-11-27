import {
	getCapabilities,
	hyperlink,
	type Keybinding,
	markFolded,
	pointerClicksActive,
	truncateToWidth,
} from "@octocodeai/octocode-tui";
import { ITEM_REF, itemLinkUrl, itemLinksClickable } from "./item-ref.ts";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { clip, plural, queryTarget } from "@octocodeai/octocode-common/clip";
import { shortcutText } from "./keys.ts";

export { clip, plural, queryTarget };
export { linkPath } from "@octocodeai/octocode-tui";

export const GUTTER = "  ⎿  ";
export const INDENT = "     ";

const UNBOUND = "unbound";

export function expandKey(): string {
	return appKey("app.tools.expand");
}

/**
 * The one expand hint, `(ctrl+o to expand)` or `(ctrl+o or click to expand)`, as plain text for the caller to style.
 * It names only what works: no key when unbound, no click without the mouse; empty when neither. Say it only where
 * content is hidden. A row that does not toggle on click passes `clickable: false`, so it never advertises one.
 * The `expand` hint carries the tui's zero-width fold mark, so transcript search can say hidden text was not searched.
 */
export function expandHint(verb = "expand", key = expandKey(), clickable = true): string {
	const bound = key !== UNBOUND && key !== "";
	const click = clickable && pointerClicksActive();
	const hint =
		bound && click ? `(${key} or click to ${verb})` : bound ? `(${key} to ${verb})` : click ? `(click to ${verb})` : "";
	return hint && verb === "expand" ? markFolded(hint) : hint;
}

/** Compact shortcut text, including an explicit unbound state. */
export function appKey(action: Keybinding): string {
	return shortcutText(action);
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
