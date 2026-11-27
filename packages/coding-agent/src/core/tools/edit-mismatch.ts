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

/** The most lines of the nearest region an error shows. */
const REGION_LINES = 12;
/** The least bigram similarity (0 to 1) for a line to count as what oldText was aimed at. */
const MIN_SIMILARITY = 0.6;

function bigrams(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (let i = 0; i < text.length - 1; i++) {
		const gram = text.slice(i, i + 2);
		counts.set(gram, (counts.get(gram) ?? 0) + 1);
	}
	return counts;
}

/** Dice coefficient of the bigrams of two whitespace-collapsed strings. */
function similarity(a: Map<string, number>, aSize: number, b: string): number {
	const size = b.length - 1;
	if (aSize <= 0 || size <= 0) return 0;
	let shared = 0;
	for (const [gram, count] of bigrams(b)) shared += Math.min(count, a.get(gram) ?? 0);
	return (2 * shared) / (aSize + size);
}

/**
 * The file region nearest to `oldText` when no line of it matches exactly: the file line most like oldText's longest
 * line (bigram similarity, whitespace collapsed), shown from where oldText would start, with line numbers. Undefined
 * when no line is similar enough.
 */
function nearestRegion(lines: readonly string[], wanted: readonly string[]): string | undefined {
	const collapse = (line: string) => line.trim().replace(/\s+/g, " ");
	let key = -1;
	for (const [index, line] of wanted.entries())
		if (collapse(line).length > (key < 0 ? 3 : collapse(wanted[key]).length)) key = index;
	if (key < 0) return undefined;
	const target = collapse(wanted[key]);
	const grams = bigrams(target);
	let best = -1;
	let bestScore = MIN_SIMILARITY;
	for (const [index, line] of lines.entries()) {
		const score = similarity(grams, target.length - 1, collapse(line));
		if (score > bestScore) {
			bestScore = score;
			best = index;
		}
	}
	if (best < 0) return undefined;
	const from = Math.max(0, best - key);
	const to = Math.min(lines.length, from + Math.min(wanted.length, REGION_LINES));
	const shown = lines.slice(from, to).map((line, offset) => `${from + offset + 1}: ${show(line)}`);
	return ` Nearest text in the file (lines ${from + 1}-${to}), which oldText did not match exactly: ${shown.join(" | ")}. Copy oldText from it.`;
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
	return nearestRegion(lines, wanted);
}
