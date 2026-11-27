import path from "node:path";
import {
	FILES_CELL,
	isSegmentFile,
	LIBRARY_COLUMNS,
	LIBRARY_FILE,
	LIBRARY_SEPARATOR,
	type LibraryColumn,
	SEGMENT_RANKED_LABELS,
} from "../archive.ts";
import { escapeRegExp } from "@octocodeai/octocode-common/regexp";
import { RECORD_FILE, recordRankedText } from "./record.ts";
import { fieldOf, MESSAGES_HEADING, rankedMessageText } from "./text.ts";

/**
 * What a ranked search (`../rank.ts`) counts in each kind of archive file: what the session said, not the wording
 * its writer repeats in every file of that kind, so a word such as `user` or `code` does not match them all. Each kind
 * is read through the constants its writer writes it with (`archive.ts`, `archive/record.ts`, `archive/text.ts`).
 */

/** The fixed words and counts of a library row's files cell (`FILES_CELL`), leaving the file names. */
const FILES_WORDS = new RegExp(
	[
		`^${escapeRegExp(FILES_CELL.modified)}`,
		`${escapeRegExp(FILES_CELL.more[0])}\\d+${escapeRegExp(FILES_CELL.more[1])}`,
		`(?:^|${escapeRegExp(FILES_CELL.join)})${escapeRegExp(FILES_CELL.read)}\\d+$`,
	].join("|"),
	"g",
);

/** A library's `lines`: each row's TL;DR, topics and file names; its title, text and table head count as empty. */
function libraryRankedText(lines: readonly string[]): string[] {
	const table = lines.indexOf(LIBRARY_SEPARATOR);
	return lines.map((line, index) => {
		if (table < 0 || index <= table || !line.startsWith("| ")) return "";
		const cells = line.slice(2, -2).split(" | ");
		// A row the table's columns do not split is counted whole rather than lost.
		if (cells.length !== LIBRARY_COLUMNS.length) return line;
		const of = (column: LibraryColumn) => cells[LIBRARY_COLUMNS.indexOf(column)];
		return [of("TL;DR"), of("Topics"), of("Files").replace(FILES_WORDS, " ")].join(" ");
	});
}

/** A segment's `lines`: the values of its `SEGMENT_RANKED_LABELS` fields, then its messages (`rankedMessageText`). */
function segmentRankedText(lines: readonly string[], openers?: Array<string | undefined>): string[] {
	const body = lines.indexOf(MESSAGES_HEADING);
	if (body < 0) return rankedMessageText(lines, openers);
	const header = lines.slice(0, body).map((line) => {
		openers?.push(undefined);
		const field = fieldOf(line);
		return field && SEGMENT_RANKED_LABELS.has(field.label) ? field.value : "";
	});
	openers?.push(undefined);
	return [...header, "", ...rankedMessageText(lines.slice(body + 1), openers)];
}

/**
 * The text of each line of archive `file` that a ranked search counts, line for line: a record's (`recordRankedText`),
 * a segment's or the library's own; any other file (a `.claim` is empty) counts as it is.
 */
export function archiveRankedText(file: string, lines: readonly string[]): readonly string[] {
	const name = path.basename(file);
	if (name === RECORD_FILE) return recordRankedText(lines);
	if (name === LIBRARY_FILE) return libraryRankedText(lines);
	return isSegmentFile(name) ? segmentRankedText(lines) : lines;
}

/**
 * What the ranked text of a line depends on before it, as lines to read around a window of the file: the window's
 * ranked text is that of `[...before, ...window, ...after]`, cut to the window (`archiveRankedWindow`). Undefined when
 * the window reads the same on its own.
 */
export interface RankedContext {
	before: string[];
	after: string[];
}

/** `archiveRankedText` of `lines`, and the context a window starting at a line needs to read the same. */
export function archiveRankedLines(
	file: string,
	lines: readonly string[],
): { ranked: readonly string[]; context(start: number): RankedContext | undefined } {
	const name = path.basename(file);
	const openers: Array<string | undefined> = [];
	const open = (at: number) => (openers[at] === undefined ? [] : [openers[at]]);
	if (name === RECORD_FILE) {
		const ranked = recordRankedText(lines, openers);
		const body = lines.findIndex((line) => line.startsWith("## "));
		return {
			ranked,
			context: (start) => (body >= 0 && start > body ? { before: ["## ", ...open(start)], after: [] } : undefined),
		};
	}
	if (name === LIBRARY_FILE) {
		const table = lines.indexOf(LIBRARY_SEPARATOR);
		return {
			ranked: libraryRankedText(lines),
			context: (start) => (table >= 0 && start > table ? { before: [LIBRARY_SEPARATOR], after: [] } : undefined),
		};
	}
	if (!isSegmentFile(name)) return { ranked: lines, context: () => undefined };
	const ranked = segmentRankedText(lines, openers);
	const body = lines.indexOf(MESSAGES_HEADING);
	return {
		ranked,
		context: (start) =>
			body >= 0 && start <= body
				? { before: [], after: [MESSAGES_HEADING] }
				: { before: [MESSAGES_HEADING, ...open(start)], after: [] },
	};
}

/** The ranked text of `window`, lines of archive `file` that start where `context` was taken (`archiveRankedLines`). */
export function archiveRankedWindow(
	file: string,
	window: readonly string[],
	context: RankedContext | undefined,
): readonly string[] {
	if (!context) return archiveRankedText(file, window);
	const ranked = archiveRankedText(file, [...context.before, ...window, ...context.after]);
	return ranked.slice(context.before.length, context.before.length + window.length);
}
