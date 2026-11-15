import { sanitizeTerminalText } from "./sanitize.ts";

/** The first line of a text (all of it when it has one line). */
export const firstLine = (text: string): string => text.split("\n")[0] ?? "";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * `text` cut to `max` characters (UTF-16 code units, so the result never exceeds `max` and callers can budget with
 * it), ending in `…` when cut: the one character clip (`clip` adds one sanitized line). The cut falls between grapheme
 * clusters, so it never leaves a dangling joiner, half a flag or a letter without its accent; a cluster that does not
 * fit is dropped whole. A line that must fit terminal columns, where a wide character counts 2, is the TUI's
 * `truncateToWidth`; counting characters and counting columns differ, so this is not one with it.
 */
export function clipText(text: string, max: number): string {
	if (max <= 0) return "";
	if (text.length <= max) return text;
	const room = max - 1;
	// Code units below U+0300 stand alone, and so does the cut when the unit after it is one too: no segmenter needed.
	if (!/[^\u0000-\u02ff]/.test(text.slice(0, room + 1))) return `${text.slice(0, room)}…`;
	let kept = "";
	for (const { segment } of graphemes.segment(text)) {
		if (kept.length + segment.length > room) break;
		kept += segment;
	}
	return `${kept}…`;
}

/** One sanitized line of at most `max` characters, ending in `…` when cut. */
export function clip(text: string, max: number): string {
	return clipText(firstLine(sanitizeTerminalText(text).replace(/\t/g, " ")).trim(), max);
}

/** `1 line`, `2 lines`; pass `many` for irregular plurals. */
export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** Search terms first (what the call looks for), then where it looks. */
const TERM_KEYS = [
	"searchText",
	"pattern",
	"matchString",
	"keywords",
	"keywordsToSearch",
	"symbolName",
	"packageName",
	"query",
	"url",
	"name",
] as const;
const PATH_KEYS = ["path", "filePath", "uri"] as const;

function stringValue(value: unknown): string {
	return Array.isArray(value)
		? value.filter((item) => typeof item === "string").join(" ")
		: typeof value === "string"
			? value
			: "";
}

/**
 * The most telling value of one query: `term in path`, `owner/repo term`, `owner/repo/path` or the term alone.
 * Unsanitized: callers clip it.
 */
export function queryTarget(query: Record<string, unknown>): string {
	const repo =
		typeof query.owner === "string" && typeof query.repo === "string" ? `${query.owner}/${query.repo}` : undefined;
	const term = TERM_KEYS.map((key) => stringValue(query[key])).find(Boolean) ?? "";
	const path = PATH_KEYS.map((key) => stringValue(query[key])).find(Boolean) ?? "";
	const where = repo && path ? `${repo}/${path}` : ((path || repo) ?? "");
	if (term && path) return `${term} in ${where}`;
	if (term) return repo ? `${repo} ${term}` : term;
	return where;
}
