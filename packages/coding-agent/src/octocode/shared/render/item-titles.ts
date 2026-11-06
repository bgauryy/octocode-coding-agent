import { sanitizeTerminalText } from "../../../../../common/src/sanitize.ts";

/** Longest title drawn next to an ID, in characters, ellipsis included. */
export const TITLE_CAP = 48;

const ID = /\bB\d{1,9}\b/g;

let titles: ReadonlyMap<string, string> = new Map();

/** Replaces the cached titles (`B12` → title) of this workspace's backlog; the backlog owner calls it when the board changes. */
export function setItemTitles(next: ReadonlyMap<string, string>): void {
	titles = next;
}

/** The cached title of `ref`, synchronously and without any read: undefined for an unknown item. */
export function itemTitle(ref: string): string | undefined {
	return titles.get(ref);
}

/** How the pieces of a decorated line are drawn: the ID, the quoted title, and the text between (identity by default). */
export interface ItemTitleStyle {
	id?: (ref: string) => string;
	title?: (quoted: string) => string;
	text?: (plain: string) => string;
}

function capTitle(title: string): string {
	const flat = sanitizeTerminalText(title).replace(/\s+/g, " ").trim();
	return flat.length > TITLE_CAP ? `${flat.slice(0, TITLE_CAP - 1).trimEnd()}…` : flat;
}

function decorateLine(line: string, titleOf: (ref: string) => string | undefined, style: ItemTitleStyle): string {
	const id = style.id ?? ((ref: string) => ref);
	const title = style.title ?? ((quoted: string) => quoted);
	const text = style.text ?? ((plain: string) => plain);
	const seen = new Set<string>();
	let out = "";
	let at = 0;
	let changed = false;
	for (const match of line.matchAll(ID)) {
		const ref = match[0];
		const end = match.index + ref.length;
		// Decorated once per line, and never twice: an ID already followed by a quoted title is left alone.
		if (seen.has(ref) || line.startsWith(" “", end)) continue;
		const found = titleOf(ref);
		if (!found) continue;
		seen.add(ref);
		out += text(line.slice(at, match.index)) + id(ref) + title(` “${capTitle(found)}”`);
		at = end;
		changed = true;
	}
	return changed ? out + text(line.slice(at)) : text(line);
}

/**
 * `text` with titles added only inside its last occurrence of `part`: a host-written footer after text that is someone
 * else's (a child's report), where the rest must stay as written. `text` is unchanged when `part` is empty or absent.
 */
export function withItemTitlesIn(text: string, part: string, titleOf: (ref: string) => string | undefined): string {
	const at = part ? text.lastIndexOf(part) : -1;
	return at < 0 ? text : text.slice(0, at) + withItemTitles(part, titleOf) + text.slice(at + part.length);
}

/**
 * `text` for display with each known backlog ID (`B92`) followed by its title (`B92 “Clickable backlog IDs”`). An unknown
 * ID stays as it is, and an ID is decorated once per line. Pure: the stored text is never changed, only the string drawn
 * from it. The caller cuts the result to its width, so this module needs no terminal code.
 */
export function withItemTitles(
	text: string,
	titleOf: (ref: string) => string | undefined,
	style: ItemTitleStyle = {},
): string {
	return text
		.split("\n")
		.map((line) => decorateLine(line, titleOf, style))
		.join("\n");
}
