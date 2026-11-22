/** Applying matched text replacements to the original text. */

export interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

export type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

/** Disjoint replacements, at offsets of `content`, applied in one pass. */
export function applyReplacements(content: string, replacements: TextReplacement[]): string {
	const parts: string[] = [];
	let position = 0;
	for (const replacement of [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)) {
		const start = replacement.matchIndex;
		parts.push(content.slice(position, start), replacement.newText);
		position = start + replacement.matchLength;
	}
	parts.push(content.slice(position));
	return parts.join("");
}

/**
 * Apply replacements matched in `normalizeToLF(originalContent)` to `originalContent` itself. Text outside the replaced
 * ranges keeps its bytes, line endings included, so a file with mixed CRLF and LF lines keeps both. Line breaks in the
 * new text get the ending of the line where the replaced range starts. The result, normalized to LF, equals the
 * replacements applied to the normalized content.
 */
export function applyReplacementsToOriginal(originalContent: string, replacements: TextReplacement[]): string {
	// Only CRLF changes length when normalizing: the LF of the n-th CRLF (at original offset p) is at p - n in the
	// normalized text. Adding the number of CRLFs before a normalized offset gives the original offset, and a range that
	// covers that LF covers the whole CRLF.
	let crlfBefore = 0;
	let nextCrlf = originalContent.indexOf("\r\n");
	const toOriginal = (offset: number): number => {
		while (nextCrlf !== -1 && nextCrlf - crlfBefore < offset) {
			crlfBefore++;
			nextCrlf = originalContent.indexOf("\r\n", nextCrlf + 2);
		}
		return offset + crlfBefore;
	};

	const parts: string[] = [];
	let endsWithCr = false;
	const push = (part: string): void => {
		if (part.length === 0) return;
		// A CR before a seam and an LF after it would merge into one CRLF line break, for example a kept lone CR followed
		// by inserted text that starts with LF. Adding an LF turns the CR into a CRLF of its own, so the written file has
		// the line breaks the diff shows.
		if (endsWithCr && part[0] === "\n") parts.push("\n");
		parts.push(part);
		endsWithCr = part[part.length - 1] === "\r";
	};
	let position = 0;
	for (const replacement of [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)) {
		const start = toOriginal(replacement.matchIndex);
		push(originalContent.slice(position, start));
		const ending = lineEndingAt(originalContent, start);
		push(ending === "\n" ? replacement.newText : replacement.newText.replaceAll("\n", ending));
		position = toOriginal(replacement.matchIndex + replacement.matchLength);
	}
	push(originalContent.slice(position));
	return parts.join("");
}

/**
 * Line ending of the line containing `offset`: its own LF or CRLF, or that of the line before for an unterminated last
 * line. A lone CR only counts in files without any LF (classic Mac line endings); elsewhere it is more likely a control
 * character inside a line.
 */
function lineEndingAt(content: string, offset: number): "\r\n" | "\n" | "\r" {
	let lineFeed = content.indexOf("\n", offset);
	if (lineFeed === -1) lineFeed = content.lastIndexOf("\n", offset);
	if (lineFeed === -1) return content.includes("\r") ? "\r" : "\n";
	return content[lineFeed - 1] === "\r" ? "\r\n" : "\n";
}
