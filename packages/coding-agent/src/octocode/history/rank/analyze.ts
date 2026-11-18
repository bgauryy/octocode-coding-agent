import { archiveRankedLines, type RankedContext } from "../archive/ranked.ts";
import { BOUNDARY, PASSAGE_LINES, type Query, termsOf, termTest, WORD } from "./terms.ts";

/**
 * One archive file cut into passages (a message, tool call or section, at most `PASSAGE_LINES` lines) and counted:
 * `scanLines` for one query, `analyzeLines` for the index. Both count what `archiveRankedLines` keeps of each line.
 */

/** A query ready to scan with: its terms by index, and a test that passes for any text that may hold one. */
export interface ScanQuery extends Query {
	wanted: ReadonlySet<string>;
	index: ReadonlyMap<string, number>;
	test: RegExp;
}

export function scanQuery(query: Query): ScanQuery {
	return {
		...query,
		wanted: new Set(query.terms),
		index: new Map(query.terms.map((term, at) => [term, at])),
		test: termTest(query.terms),
	};
}

/** Where a passage is: 0-based first and last line, the bytes they span (no final newline), the ranked-text context. */
interface PassageSpan {
	start: number;
	end: number;
	byteStart: number;
	byteEnd: number;
	context?: RankedContext;
}

/** A passage with a query term: its counts by term index, terms covered, words, and quoted phrases it holds. */
export interface PassageHit extends PassageSpan {
	tf: number[];
	covered: number;
	length: number;
	phrases: number;
}

export interface FileScan {
	passages: number;
	words: number;
	/** Query terms in the file's first passage: with its label, its header. */
	firstTerms: string[];
	hits: PassageHit[];
}

/** Passages between cancellation checks. */
const PASSAGES_PER_CHECK = 256;

/** Each passage of `lines` as its first and last line, with the byte offset of its first line. */
function* passagesOf(lines: readonly string[]): Generator<{ start: number; end: number; byteStart: number }> {
	let byte = 0;
	for (let start = 0; start < lines.length;) {
		let end = start;
		while (end + 1 < lines.length && end + 1 - start < PASSAGE_LINES && !BOUNDARY.test(lines[end + 1])) end++;
		yield { start, end, byteStart: byte };
		for (let at = start; at <= end; at++) byte += Buffer.byteLength(lines[at]) + 1;
		start = end + 1;
	}
}

const byteEnd = (lines: readonly string[], start: number, end: number, byteStart: number) => {
	let byte = byteStart - 1;
	for (let at = start; at <= end; at++) byte += Buffer.byteLength(lines[at]) + 1;
	return byte;
};

/**
 * The passages of `lines` (of archive `file`) holding a term of `query`, with every passage's word count. Only a
 * passage the query's `test` passes is counted word by word; the others only count their words. `keep` drops hits
 * outside a `query` filter; `check` runs between batches of passages (cancellation).
 */
export async function scanLines(
	file: string,
	lines: readonly string[],
	query: ScanQuery,
	keep?: (start: number, end: number) => boolean,
	check?: () => void | Promise<void>,
): Promise<FileScan> {
	const { ranked, context } = archiveRankedLines(file, lines);
	const result: FileScan = { passages: 0, words: 0, firstTerms: [], hits: [] };
	for (const { start, end, byteStart } of passagesOf(lines)) {
		if (++result.passages % PASSAGES_PER_CHECK === 0 && check) await check();
		let tf: number[] | undefined;
		let covered = 0;
		let length = 0;
		for (let at = start; at <= end; at++) {
			const line = ranked[at];
			// A line the test rejects holds no query term: only its words count.
			if (!query.test.test(line.toLowerCase())) {
				length += line.match(WORD)?.length ?? 0;
				continue;
			}
			tf ??= Array.from({ length: query.terms.length }, () => 0);
			for (const [word] of line.matchAll(WORD)) {
				length++;
				for (const term of termsOf(word)) {
					const index = query.index.get(term);
					if (index === undefined) continue;
					if (tf[index]++ === 0) covered++;
				}
			}
		}
		result.words += length;
		if (!tf) continue;
		if (start === 0) result.firstTerms = query.terms.filter((_, at) => tf[at] > 0);
		if (covered === 0 || (keep && !keep(start, end))) continue;
		let phrases = 0;
		if (query.phrases.length > 0) {
			const text = ranked
				.slice(start, end + 1)
				.join("\n")
				.toLowerCase();
			for (const phrase of query.phrases) if (text.includes(phrase)) phrases++;
		}
		const span = context(start);
		result.hits.push({
			start,
			end,
			byteStart,
			byteEnd: byteEnd(lines, start, end, byteStart),
			...(span ? { context: span } : {}),
			tf,
			covered,
			length,
			phrases,
		});
	}
	return result;
}

/** A passage as the index stores it: where it is, its word count, and its terms in order, space-separated. */
export interface IndexedPassage extends PassageSpan {
	length: number;
	body: string;
}

/** Every passage of `lines` (of archive `file`) with all its terms, for the index. */
export function analyzeLines(file: string, lines: readonly string[]): IndexedPassage[] {
	const { ranked, context } = archiveRankedLines(file, lines);
	const passages: IndexedPassage[] = [];
	for (const { start, end, byteStart } of passagesOf(lines)) {
		const terms: string[] = [];
		let length = 0;
		for (let at = start; at <= end; at++)
			for (const [word] of ranked[at].matchAll(WORD)) {
				length++;
				for (const term of termsOf(word)) terms.push(term);
			}
		const span = context(start);
		passages.push({
			start,
			end,
			byteStart,
			byteEnd: byteEnd(lines, start, end, byteStart),
			...(span ? { context: span } : {}),
			length,
			body: terms.join(" "),
		});
	}
	return passages;
}
