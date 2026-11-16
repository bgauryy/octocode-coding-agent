import { isUnifiedDiff } from "../utils/code-sniff.ts";
import { isHighlightable, resolveLanguage } from "../utils/syntax-highlight.ts";
import { renderDiff } from "./diff.ts";
import { getLanguageFromPath, highlightCode } from "./theme-tui-helpers.ts";
import type { Theme } from "./theme-class.ts";
import type { ThemeColor } from "./theme-types.ts";

/** A line that starts with a failure word (`error:`, `fatal:`, `FAIL src/a.test.ts`, `npm ERR!`, `TypeError: x`) or mark. */
const ERROR_LINE =
	/^\s*(?:(?:npm )?(?:error|err!|fatal|failed|fail|panic|exception|traceback)\b|\w*(?:Error|Exception):|[✗✖×]\s)/i;
const WARNING_LINE = /^\s*(?:npm )?(?:warning|warn|deprecated)\b/i;
/** `path:line` or `path:line:col` at the start of a line (compiler, grep and linter output), then a separator or the end. */
const PATH_HEAD = /^(\s*)(\S+?):(\d+)(?::\d+)?(?=[:\s]|$)/;
/** More lines than this are painted line by line: a unified diff is laid out whole, which only pays for output a person reads. */
const MAX_DIFF_LINES = 2000;

/** The `path:line[:col]` head of `line`, when its path part looks like a file (has a directory or an extension). */
function pathHead(line: string): { lead: string; head: string } | undefined {
	const match = PATH_HEAD.exec(line);
	if (!match) return undefined;
	const [whole, lead, file] = match;
	if (file.includes("://") || !(file.includes("/") || /\.\w+$/.test(file))) return undefined;
	return { lead, head: whole.slice(lead.length) };
}

/**
 * One line of shell output: a failure line in the error colour, a warning line in the warning colour, and a
 * `path:line[:col]` head as a path; any other line keeps `base`. Blank lines stay unstyled.
 */
function styleShellLine(theme: Theme, line: string, base: ThemeColor): string {
	if (line.trim() === "") return line;
	if (base !== "error") {
		if (ERROR_LINE.test(line)) return theme.fg("error", line);
		if (WARNING_LINE.test(line)) return theme.fg("warning", line);
		const path = pathHead(line);
		if (path)
			return `${path.lead}${theme.fg("mdCode", path.head)}${theme.fg(base, line.slice(path.lead.length + path.head.length))}`;
	}
	return theme.fg(base, line);
}

/** Shell output as styled lines: a unified diff (`git diff`) as a diff, anything else line by line (`styleShellLine`). */
export function styleShellLines(theme: Theme, lines: readonly string[], base: ThemeColor): string[] {
	if (lines.length <= MAX_DIFF_LINES && isUnifiedDiff(lines.join("\n")))
		return renderDiff(lines.join("\n")).split("\n");
	return lines.map((line) => styleShellLine(theme, line, base));
}

/** A `12: code` / `12│ code` / `12<tab>code` line-number gutter that a reader tool puts before every line. */
const GUTTER = /^\s*\d+(?:[:│|]\s?|\t)/;
/** Text that starts like a key list (`results:`): data, not source code, whatever the file the call named. */
const STRUCTURED = /^\s*[A-Za-z_][\w-]*:(?:\s|$)/;

/** `lines` highlighted as `language`, their line-number gutter (when every line has one) kept as a muted prefix. */
function highlightLines(theme: Theme, lines: string[], language: string): string[] {
	const filled = lines.filter((line) => line.trim() !== "");
	const gutters = filled.length > 0 && filled.every((line) => GUTTER.test(line));
	const heads = gutters ? lines.map((line) => GUTTER.exec(line)?.[0] ?? "") : lines.map(() => "");
	const code = lines.map((line, index) => line.slice(heads[index].length).replace(/\t/g, "   "));
	const colored = highlightCode(code.join("\n"), language, theme);
	return colored.length === lines.length
		? colored.map((line, index) => `${heads[index] ? theme.fg("muted", heads[index]) : ""}${line}`)
		: lines.map((line) => theme.fg("toolOutput", line));
}

/** Text no longer than the highlighter's cache takes is parsed to tell JSON; a longer one is left plain. */
const MAX_DETECT_CHARS = 256 * 1024;

/**
 * The language of output whose call named no file: `json` when the whole text parses as an object or array, `yaml` when
 * at least 2 of its first 5 non-blank lines are `key:` pairs (prose with one colon stays plain). Undefined otherwise.
 */
export function outputLanguage(text: string): "json" | "yaml" | undefined {
	if (text.length > MAX_DETECT_CHARS) return undefined;
	const body = text.trim();
	if (/^[[{]/.test(body)) {
		try {
			JSON.parse(body);
			return "json";
		} catch {
			// Not a JSON document: it may still be key lines.
		}
	}
	const head = body
		.split("\n", 40)
		.filter((line) => line.trim() !== "")
		.slice(0, 5);
	return head.filter((line) => STRUCTURED.test(line)).length >= 2 ? "yaml" : undefined;
}

/**
 * Tool output coloured by what it is: a unified diff, or code when the call named a file of a known language
 * (`path`). Collapsed, only the first `previewLines` lines are coloured (the rest stay plain: they are not shown);
 * code with a line over 4 KiB, or over the highlighter's size limits, stays plain. Undefined when neither applies.
 */
export function colorToolOutput(
	theme: Theme,
	text: string,
	options: { path?: string; expanded: boolean; previewLines: number },
): string | undefined {
	const lines = text.split("\n");
	const shown = options.expanded ? lines : lines.slice(0, options.previewLines);
	const rest = options.expanded ? [] : lines.slice(options.previewLines).map((line) => theme.fg("toolOutput", line));
	if (isUnifiedDiff(text)) {
		if (options.expanded && lines.length > MAX_DIFF_LINES) return undefined;
		return [...renderDiff(shown.join("\n")).split("\n"), ...rest].join("\n");
	}
	const named = options.path ? resolveLanguage(getLanguageFromPath(options.path)) : undefined;
	const first = lines.find((line) => line.trim() !== "") ?? "";
	// A named file's language wins unless the text is key lines (data, not source); then, or with no file, its shape decides.
	const language = named && (named === "yaml" || !STRUCTURED.test(first)) ? named : outputLanguage(text);
	if (!language) return undefined;
	if (!isHighlightable(shown.join("\n"))) return undefined;
	return [...highlightLines(theme, shown, language), ...rest].join("\n");
}
