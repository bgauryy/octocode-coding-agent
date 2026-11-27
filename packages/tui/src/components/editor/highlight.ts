/** A span of a rendered editor line, as UTF-16 offsets: `start` inclusive, `end` exclusive. */
export interface WordRange {
	start: number;
	end: number;
}

/**
 * Draws chosen words of the prompt in a style. The app supplies it (the editor knows no vocabulary); `find` reads one
 * rendered line and returns non-overlapping ranges in order. The cursor cell is never styled.
 */
export interface EditorWordHighlight {
	find(line: string): readonly WordRange[];
	style(text: string): string;
}

/** The part `[from, to)` of `text` with the ranges' overlap styled; text outside the ranges is kept as it is. */
function paintWords(
	text: string,
	ranges: readonly WordRange[],
	style: (text: string) => string,
	from = 0,
	to = text.length,
): string {
	let out = "";
	let at = from;
	for (const range of ranges) {
		const start = Math.max(range.start, from);
		const end = Math.min(range.end, to);
		if (start >= end) continue;
		out += text.slice(at, start) + style(text.slice(start, end));
		at = end;
	}
	return out + text.slice(at, to);
}

/** `(from, to) => text`: a part of `line` with its highlighted words styled; plain without a highlight. */
export function linePainter(
	line: string,
	highlight: EditorWordHighlight | undefined,
): (from: number, to?: number) => string {
	if (!highlight) return (from, to = line.length) => line.slice(from, to);
	const words = highlight.find(line);
	return (from, to = line.length) => paintWords(line, words, highlight.style, from, to);
}
