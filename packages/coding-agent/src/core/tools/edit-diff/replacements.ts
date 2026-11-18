/** Applying matched text replacements, optionally preserving the original bytes of untouched lines. */

function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
	start: number;
	end: number;
}

export interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

export type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}

	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	return { startLine, endLine: endLine + 1 };
}

/** Disjoint replacements, at offsets of `content` shifted by `offset`, applied in one pass. */
export function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	const parts: string[] = [];
	let position = 0;
	for (const replacement of [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)) {
		const start = replacement.matchIndex - offset;
		parts.push(content.slice(position, start), replacement.newText);
		position = start + replacement.matchLength;
	}
	parts.push(content.slice(position));
	return parts.join("");
}

/**
 * Replacements matched against `baseContent`, widened to the whole lines they touch and rewritten as replacements of
 * those lines in `originalContent`, so applying them keeps every other line's bytes from the original.
 *
 * This is useful when `baseContent` is a normalized view of the original with the same lines. Touched lines are
 * rewritten from the normalized base. The actual replacement ranges drive preservation so duplicate normalized lines
 * cannot be aligned to the wrong occurrence.
 */
export function lineReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): TextReplacement[] {
	const originalLines = getLineSpans(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	const groups: Array<{
		startLine: number;
		endLine: number;
		replacements: TextReplacement[];
	}> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	return groups.map((group) => {
		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		const start = originalLines[group.startLine].start;
		return {
			matchIndex: start,
			matchLength: originalLines[group.endLine - 1].end - start,
			newText: applyReplacements(
				baseContent.slice(groupStartOffset, groupEndOffset),
				group.replacements,
				groupStartOffset,
			),
		};
	});
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
