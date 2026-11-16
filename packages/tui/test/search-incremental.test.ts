import assert from "node:assert";
import { describe, it } from "node:test";
import { AltScreenSearchIndex } from "../src/tui-alt-screen/search-index.ts";
import type { AltScreenSearchMatch, AltScreenSearchSegment } from "../src/tui-alt-screen/search-matches.ts";
import { SearchMatcher } from "../src/tui-alt-screen/search-matches.ts";
import { escapeRegExp } from "../src/utils/regexp.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { getGraphemeSegmenter, visibleWidth } from "../src/utils/width.ts";

// The search as it was before the incremental index: the whole corpus built and matched on every change. Kept verbatim
// as the reference the incremental index must equal.
const segmenter = getGraphemeSegmenter();

interface SearchSourceSpan {
	textStart: number;
	textEnd: number;
	row: number;
	startCol: number;
	endCol: number;
	linearColumns: boolean;
}

interface SearchCorpus {
	text: string;
	spans: SearchSourceSpan[];
}
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function buildSearchCorpus(lines: readonly string[]): SearchCorpus {
	const chunks: string[] = [];
	const spans: SearchSourceSpan[] = [];
	let textLength = 0;
	let pendingSeparator = false;

	const appendSeparator = (): void => {
		if (!pendingSeparator) return;
		chunks.push(" ");
		textLength += 1;
		pendingSeparator = false;
	};

	for (let row = 0; row < lines.length; row++) {
		const line = stripTerminalSequences(lines[row] ?? "");
		let column = 0;

		// Rendered transcripts are overwhelmingly ASCII. Index complete non-space
		// runs at once instead of segmenting and allocating one mapping per cell.
		if (PRINTABLE_ASCII.test(line)) {
			let index = 0;
			while (index < line.length) {
				if (line.charCodeAt(index) === 0x20) {
					if (textLength > 0) pendingSeparator = true;
					column += 1;
					index += 1;
					continue;
				}
				let end = index + 1;
				while (end < line.length && line.charCodeAt(end) !== 0x20) end += 1;
				appendSeparator();
				const text = line.slice(index, end);
				chunks.push(text);
				spans.push({
					textStart: textLength,
					textEnd: textLength + text.length,
					row,
					startCol: column,
					endCol: column + text.length,
					linearColumns: true,
				});
				textLength += text.length;
				column += text.length;
				index = end;
			}
		} else {
			for (const grapheme of segmenter.segment(line)) {
				const text = grapheme.segment;
				const width = visibleWidth(text);
				if (/^\s+$/u.test(text)) {
					if (textLength > 0) pendingSeparator = true;
					column += width;
					continue;
				}
				appendSeparator();
				chunks.push(text);
				spans.push({
					textStart: textLength,
					textEnd: textLength + text.length,
					row,
					startCol: column,
					endCol: column + width,
					linearColumns: false,
				});
				textLength += text.length;
				column += width;
			}
		}
		if (textLength > 0) pendingSeparator = true;
	}

	return { text: chunks.join(""), spans };
}

function normalizeQuery(query: string): string {
	return query.replace(/\s+/gu, " ").trim();
}

function findSearchCorpusMatches(corpus: SearchCorpus, normalizedQuery: string): AltScreenSearchMatch[] {
	if (!normalizedQuery) return [];
	const expression = new RegExp(escapeRegExp(normalizedQuery), "giu");
	const matches: AltScreenSearchMatch[] = [];
	let spanIndex = 0;

	for (const match of corpus.text.matchAll(expression)) {
		const start = match.index;
		const end = start + match[0].length;
		while (spanIndex < corpus.spans.length && corpus.spans[spanIndex].textEnd <= start) spanIndex += 1;

		const segments: AltScreenSearchSegment[] = [];
		for (let index = spanIndex; index < corpus.spans.length; index++) {
			const span = corpus.spans[index];
			if (span.textStart >= end) break;
			if (span.textEnd <= start) continue;
			const startCol = span.linearColumns
				? span.startCol + Math.max(start, span.textStart) - span.textStart
				: span.startCol;
			const endCol = span.linearColumns ? span.startCol + Math.min(end, span.textEnd) - span.textStart : span.endCol;
			const previous = segments[segments.length - 1];
			if (previous && previous.row === span.row && startCol <= previous.endCol) {
				previous.endCol = Math.max(previous.endCol, endCol);
			} else {
				segments.push({ row: span.row, startCol, endCol });
			}
		}
		while (spanIndex < corpus.spans.length && corpus.spans[spanIndex].textEnd <= end) spanIndex += 1;
		if (segments.length > 0) matches.push({ segments });
	}

	return matches;
}

function referenceMatches(lines: readonly string[], query: string): AltScreenSearchMatch[] {
	const normalizedQuery = normalizeQuery(query);
	return normalizedQuery ? findSearchCorpusMatches(buildSearchCorpus(lines), normalizedQuery) : [];
}

function random(seed: number): (limit: number) => number {
	let state = seed;
	return (limit) => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return Math.floor((state / 2147483648) * limit);
	};
}

const WORDS = ["fox", "Fox", "the", "quick", "brown", "ſox", "界", "🙂", "é", "a", "x", "\x1b[31mred\x1b[0m", "  ", ""];
const QUERIES = ["fox", "the quick", "o", "x fox", "brown fox the", "界 🙂", "red fox", "a a", "é", "k"];

function randomLine(next: (limit: number) => number): string {
	return Array.from({ length: next(9) }, () => WORDS[next(WORDS.length)]).join(next(4) === 0 ? "  " : " ");
}

/** Run `index` to completion, resuming between calls as the frames and slices do. */
function searchToEnd(index: AltScreenSearchIndex, lines: string[], query: string, budgetMs: number) {
	let result = index.search(lines, query, budgetMs);
	for (let guard = 0; !result.complete && guard < 100_000; guard++) {
		index.continue(budgetMs);
		result = index.search(lines, query, budgetMs);
	}
	return result;
}

describe("incremental transcript search", () => {
	it("finds exactly the matches of a full rebuild after random appends, edits and removals", () => {
		for (const [seed, budget] of [
			[1, Number.POSITIVE_INFINITY],
			[2, 0],
			[3, Number.POSITIVE_INFINITY],
			[4, 0],
			[5, 0.01],
		] as const) {
			const next = random(seed);
			const index = new AltScreenSearchIndex();
			let lines = Array.from({ length: 50 + next(100) }, () => randomLine(next));
			let query = QUERIES[next(QUERIES.length)];
			for (let step = 0; step < 300; step++) {
				const op = next(10);
				lines = lines.slice();
				if (op <= 2) for (let count = 1 + next(5); count > 0; count--) lines.push(randomLine(next));
				else if (op === 3) lines[lines.length - 1] = `${lines[lines.length - 1]} ${randomLine(next)}`;
				else if (op === 4) lines[next(lines.length)] = randomLine(next);
				else if (op === 5 && lines.length > 5) lines.splice(next(lines.length), 1 + next(3));
				else if (op === 6) lines.splice(next(lines.length), 0, randomLine(next));
				else if (op === 7) query = QUERIES[next(QUERIES.length)];
				else if (op === 8) lines = lines.slice(0, Math.max(1, lines.length - next(10)));
				const result = searchToEnd(index, lines, query, budget);
				assert.deepStrictEqual(result.matches, referenceMatches(lines, query), `seed ${seed}, step ${step}`);
			}
		}
	});

	it("keeps the result while nothing changed and reports a change otherwise", () => {
		const index = new AltScreenSearchIndex();
		const first = index.search(["a fox", "b"], "fox");
		assert.strictEqual(first.changed, true);
		const same = index.search(["a fox", "b"], "fox");
		assert.strictEqual(same.changed, false);
		assert.strictEqual(same.matches, first.matches);
		const appended = index.search(["a fox", "b", "fox"], "fox");
		assert.strictEqual(appended.changed, true);
		assert.strictEqual(appended.matches.length, 2);
	});

	it("never blocks past its budget: a long transcript is indexed over several calls", () => {
		const lines = Array.from({ length: 60_000 }, (_, row) => `row ${row} the quick brown fox jumps over the lazy dog`);
		const index = new AltScreenSearchIndex();
		const start = performance.now();
		const result = index.search(lines, "fox", 5);
		assert.ok(performance.now() - start < 50, "the first call returned within its budget");
		assert.strictEqual(result.complete, false);
		assert.deepStrictEqual(result.matches, []);
		assert.ok(result.progress >= 0 && result.progress < 1);
		const done = searchToEnd(index, lines, "fox", 5);
		assert.strictEqual(done.matches.length, 60_000);
		assert.deepStrictEqual(done.matches, referenceMatches(lines, "fox"));
	});

	it("fails against the full rebuild when a change keeps a match it must rescan (the check can fail)", () => {
		const proto = SearchMatcher.prototype as unknown as { invalidateFrom(position: number): void };
		const original = proto.invalidateFrom;
		// Broken: keeps every match found so far, so one crossing the changed text survives the change.
		proto.invalidateFrom = function (this: SearchMatcher, position: number) {
			original.call(this, Number.POSITIVE_INFINITY);
			void position;
		};
		try {
			assert.throws(() => {
				const index = new AltScreenSearchIndex();
				searchToEnd(index, ["the fox", "brown"], "fox", Number.POSITIVE_INFINITY);
				const lines = ["the dog", "brown"];
				assert.deepStrictEqual(
					searchToEnd(index, lines, "fox", Number.POSITIVE_INFINITY).matches,
					referenceMatches(lines, "fox"),
				);
			});
		} finally {
			proto.invalidateFrom = original;
		}
	});
});
