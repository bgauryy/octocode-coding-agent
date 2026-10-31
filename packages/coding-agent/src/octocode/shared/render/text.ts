import { type Keybinding, truncateToWidth } from "@octocodeai/octocode-tui";
import { shortcutText } from "../keys.ts";
import { sanitizeTerminalText } from "../sanitize.ts";
import { clipText, firstLine } from "../util.ts";

export const GUTTER = "  ⎿  ";
export const INDENT = "     ";

/** The configured tool-output expansion key. */
export function expandKey(): string {
	return appKey("app.tools.expand");
}

/** Compact shortcut text, including an explicit unbound state. */
export function appKey(action: Keybinding): string {
	return shortcutText(action).toLowerCase();
}

/** Fewest words a model-given reason needs to say anything the row's title does not (`Edit` alone does not; `Run tests` does). */
const REASON_MIN_WORDS = 2;

/** Whether a call's `reason` carries information worth a `↳` line. */
export function isInformativeReason(reason: string | undefined): reason is string {
	return reason !== undefined && reason.trim().split(/\s+/).length >= REASON_MIN_WORDS;
}

/** `1 line`, `2 lines`; pass `many` for irregular plurals. */
export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** A multi-line message (an error that lists what was wrong) as one line, for a summary that `clip` would cut at its first line. */
export function oneLine(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.join(" ");
}

/** One sanitized line of at most `max` characters, ending in `…` when cut. */
export function clip(text: string, max: number): string {
	return clipText(firstLine(sanitizeTerminalText(text).replace(/\t/g, " ")).trim(), max);
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

/** Search terms first (what the call looks for), then where it looks. */
const TERM_KEYS = [
	"searchText",
	"pattern",
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
