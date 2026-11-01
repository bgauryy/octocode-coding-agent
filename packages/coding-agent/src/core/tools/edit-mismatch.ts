/**
 * Why an edit's `oldText` is not in the file, shown as the file's actual bytes: the first line of the file the text was
 * aimed at, as JSON (so a tab, a trailing space, a carriage return or a copied line-number prefix is visible), next to the
 * line the model sent. Undefined when no line of the file is close enough to name.
 */

const SHOWN_CHARS = 160;

/** A read tool's line-number gutter (`12\t`, `  12→`, `12│ `) that came along with the copied text. */
const GUTTER = /^\s*\d+\s*[\t→│|]\s?/;

const show = (line: string): string =>
	JSON.stringify(line.length > SHOWN_CHARS ? `${line.slice(0, SHOWN_CHARS)}…` : line);

function firstDifference(content: readonly string[], start: number, wanted: readonly string[]): number {
	for (let offset = 0; offset < wanted.length; offset++) {
		if (content[start + offset] !== wanted[offset]) return offset;
	}
	return -1;
}

/**
 * Whether `oldText` is the file's text with one tab added to every non-empty line, the way a read's `N<TAB>` line-number
 * separator looks when copied as indentation: removing exactly one leading tab from each line gives one exact match.
 */
function hasExtraLeadingTab(content: string, wanted: readonly string[]): boolean {
	const lines = wanted.filter((line) => line !== "");
	if (lines.length === 0 || !lines.every((line) => line.startsWith("\t"))) return false;
	const needle = wanted.map((line) => (line.startsWith("\t") ? line.slice(1) : line)).join("\n");
	const first = content.indexOf(needle);
	return first >= 0 && content.indexOf(needle, first + 1) < 0;
}

/** `content` and `oldText` are LF-normalized. */
export function mismatchHint(content: string, oldText: string): string | undefined {
	const wanted = oldText.split("\n");
	const anchor = wanted.findIndex((line) => line.trim() !== "");
	if (anchor < 0) return undefined;
	if (hasExtraLeadingTab(content, wanted))
		return " oldText has one extra leading tab on each line, likely the line-number separator copied from a read: send only the file's text.";
	const lines = content.split("\n");
	const stripped = wanted.map((line) => line.replace(GUTTER, ""));
	for (const candidate of [wanted, stripped]) {
		const key = candidate[anchor].trim();
		if (key === "") continue;
		const at = lines.findIndex((line) => line.trim() === key);
		if (at < 0) continue;
		const start = at - anchor;
		if (start < 0) continue;
		const offset = firstDifference(lines, start, candidate);
		if (offset < 0) {
			return candidate === stripped
				? ` The text matches line ${start + 1} of the file once the line-number prefix of each line is removed: send only the file's text.`
				: undefined;
		}
		const row = start + offset;
		const actual = lines[row];
		return ` Line ${row + 1} of the file is ${actual === undefined ? "missing (the file ends before it)" : show(actual)}; oldText has ${show(candidate[offset])}.`;
	}
	return undefined;
}
