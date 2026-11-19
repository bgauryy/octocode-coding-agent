import { sanitizeTerminalText } from "./sanitize.ts";

/** Longest title drawn next to an ID, in characters, ellipsis included. */
export const TITLE_CAP = 48;

const ID = /\bB\d{1,9}\b/g;
const ID_TEST = /\bB\d{1,9}\b/;

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

/** Characters that may sit between an ID and a title the writer typed: `B12 (Title)`, `B12: Title`, `B12 — “Title”`. */
const TITLE_LEAD = /^[\s(“"'*_:—–-]*/;

/** Whether the text after an ID already starts with the item's title (its first 12 characters, any case). */
function titleFollows(line: string, end: number, title: string): boolean {
	const after = line.slice(end);
	const rest = after.slice(TITLE_LEAD.exec(after)?.[0].length ?? 0).toLowerCase();
	const head = capTitle(title).slice(0, 12).toLowerCase();
	return head.length > 0 && rest.startsWith(head);
}

function decorateLine(
	line: string,
	titleOf: (ref: string) => string | undefined,
	style: ItemTitleStyle,
	seen = new Set<string>(),
): string {
	const id = style.id ?? ((ref: string) => ref);
	const title = style.title ?? ((quoted: string) => quoted);
	const text = style.text ?? ((plain: string) => plain);
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
		// The writer named it already: counts as its mention, and nothing is added.
		if (titleFollows(line, end, found)) {
			seen.add(ref);
			continue;
		}
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

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/** An inline code span: a run of backticks, its text, and the same run closing it. */
const CODE_SPAN = /(`+)[\s\S]*?(?<!`)\1(?!`)/g;

/**
 * Markdown with each known ID followed by its title at its first mention in the whole text, as `withItemTitles` draws
 * it; code (fenced blocks and inline spans) stays as written, so paths, commands and quoted output are never changed.
 */
export function withItemTitlesInMarkdown(markdown: string, titleOf: (ref: string) => string | undefined): string {
	if (!ID_TEST.test(markdown)) return markdown;
	const seen = new Set<string>();
	let fence: string | undefined;
	return markdown
		.split("\n")
		.map((line) => {
			const marker = FENCE.exec(line)?.[1];
			if (fence) {
				if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = undefined;
				return line;
			}
			if (marker) {
				fence = marker;
				return line;
			}
			let out = "";
			let at = 0;
			for (const span of line.matchAll(CODE_SPAN)) {
				out += decorateLine(line.slice(at, span.index), titleOf, {}, seen) + span[0];
				at = span.index + span[0].length;
			}
			return out + decorateLine(line.slice(at), titleOf, {}, seen);
		})
		.join("\n");
}
