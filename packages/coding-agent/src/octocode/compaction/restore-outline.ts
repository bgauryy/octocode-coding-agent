import { cutText } from "../../../../common/src/text.ts";

/**
 * The outline of a file too long to come back whole after a compaction: its declarations (functions, classes, types,
 * constants, Markdown headings) as `line: text`, so the model sees what the file holds and where, and reads the part it
 * needs. A line-based heuristic, not a parser: it keeps lines that start a declaration at shallow indentation, in any
 * language, and says nothing of what a body does. A file with no such line has no outline (the restore shows a window).
 */

/** Characters kept of one declaration line. */
const ROW_CHARS = 140;
/** One indentation step (a tab, or up to this many spaces): a class member is one step in, a local is deeper or is not a declaration keyword. */
const MAX_INDENT = 4;

/** Declarations at the top of a file (`export` and `async` start `export const`, `async function`). */
const TOP_LEVEL = new RegExp(
	"^(?:function|class|interface|type|enum|namespace|module|def|fn|struct|trait|impl|func|const|let|var|static|object|record|package|export|abstract|async|pub|public|private|protected)\\b|^#{1,6}\\s+\\S",
);
/** What one step in can declare: members, never a local `const` or `let`. */
const MEMBER =
	/^(?:function|class|interface|type|enum|def|fn|struct|trait|impl|func|static|abstract|async|pub|public|private|protected)\b/;
/** A method written without a keyword (`name(args) {`), but not a control statement. */
const METHOD =
	/^(?!(?:if|for|while|switch|catch|return|else|do|try|with)\b)[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\([^)]*\)[^;=]*\{$/;

interface Row {
	line: number;
	text: string;
}

export interface Outline {
	/** The rows as shown, one `line: text` each. */
	text: string;
	/** How many rows are shown, and how many declarations the file has. */
	shown: number;
	count: number;
	/** The shown row that contains the line last read or changed, marked `>`. */
	marked: boolean;
}

function indentOf(line: string): number {
	let width = 0;
	for (const char of line) {
		if (char === " ") width++;
		else if (char === "\t") width += MAX_INDENT;
		else break;
	}
	return width;
}

/** The declaration rows of `text`, in file order. */
function declarations(text: string): Row[] {
	const rows: Row[] = [];
	text.split("\n").forEach((line, index) => {
		const indent = indentOf(line);
		if (indent > MAX_INDENT) return;
		const body = line.trim();
		if (indent === 0 ? TOP_LEVEL.test(body) || METHOD.test(body) : MEMBER.test(body) || METHOD.test(body))
			rows.push({ line: index + 1, text: cutText(body, ROW_CHARS, { chars: true }) });
	});
	return rows;
}

/**
 * The outline of `text` within `max` characters, or undefined when it has no declaration. When the rows do not all fit
 * they start a few rows before the one holding `line` (where the agent last read or changed the file), which is marked.
 */
export function outlineOf(text: string, max: number, line?: number): Outline | undefined {
	const rows = declarations(text);
	if (rows.length === 0) return undefined;
	const render = (row: Row, mark: boolean) => `${mark ? ">" : " "}${row.line}: ${row.text}`;
	const at = line === undefined ? -1 : rows.findLastIndex((row) => row.line <= line);
	const size = (row: Row) => row.text.length + String(row.line).length + 4;
	let first = 0;
	if (rows.reduce((sum, row) => sum + size(row), 0) > max && at > 3) first = at - 3;
	let last = first;
	let used = 0;
	while (last < rows.length && used + size(rows[last]) <= max) used += size(rows[last++]);
	while (last === rows.length && first > 0 && used + size(rows[first - 1]) <= max) used += size(rows[--first]);
	if (last === first) return undefined;
	const shown = rows.slice(first, last);
	return {
		text: shown.map((row, index) => render(row, first + index === at)).join("\n"),
		shown: shown.length,
		count: rows.length,
		marked: at >= first && at < last,
	};
}
