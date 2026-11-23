/**
 * How selected rows become copied lines: a row the width wrapped joins the line it continues, and the left padding
 * every copied line shares is dropped. Copy reads drawn rows, so without this a paragraph comes back cut at the
 * terminal width, each piece behind the component's padding.
 */

/** One copied line and what dedenting needs to know about the row it starts on. */
export interface SelectedLine {
	text: string;
	/** Leading spaces of the line's whole first row: the padding its component drew there. */
	readonly rowIndent: number;
	/** The column of that row the copied text starts at. */
	readonly startCol: number;
}

/** A box border at the end of a row is frame: it must not land between the two halves of a joined line. */
const TRAILING_GUTTER = /\s*[│┃]$/u;
const LEADING_SPACES = /^ */;

/** `text` with a soft-wrapped row's `piece` joined on: a cut word directly, a break at a space with one space. */
export function joinWrappedRow(text: string, piece: string, kind: "join" | "space"): string {
	const head = text.replace(TRAILING_GUTTER, "");
	if (kind === "join") return head + piece;
	const tail = piece.trimStart();
	return head && tail ? `${head} ${tail}` : head + tail;
}

/** Leading spaces of a plain row. */
export function leadingSpaces(text: string): number {
	return LEADING_SPACES.exec(text)?.[0].length ?? 0;
}

/**
 * The lines' text without the left padding they all share. Padding is counted on each line's whole row, so a line
 * whose copy starts inside its row loses only the padding left of the copied text, and relative indentation (code,
 * nested lists) stays.
 */
export function dedentSelectedLines(lines: readonly SelectedLine[]): string[] {
	let padding = Number.POSITIVE_INFINITY;
	for (const line of lines) if (line.text.length > 0) padding = Math.min(padding, line.rowIndent);
	if (!Number.isFinite(padding) || padding === 0) return lines.map((line) => line.text);
	return lines.map((line) => {
		const strip = Math.min(leadingSpaces(line.text), Math.max(0, padding - line.startCol));
		return strip > 0 ? line.text.slice(strip) : line.text;
	});
}
