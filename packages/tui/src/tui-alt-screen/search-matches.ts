/**
 * Matches of one query in a search corpus, found left to right like `String.prototype.matchAll` and kept across
 * changes: when the text from some position on changes, the matches decided before it stay and the scan resumes after
 * the last of them, so a frame that streamed a few rows rescans a few rows.
 */

import { escapeRegExp } from "../utils/regexp.ts";
import type { SearchCorpus } from "./search-corpus.ts";

export interface AltScreenSearchSegment {
	row: number;
	startCol: number;
	endCol: number;
}

export interface AltScreenSearchMatch {
	segments: AltScreenSearchSegment[];
}

/** Matches made between two clock reads while scanning. */
const MATCHES_PER_CLOCK_READ = 256;

export class SearchMatcher {
	/** Matches found so far, in text order. Replaced, never shortened, when the text changes. */
	matches: AltScreenSearchMatch[] = [];
	complete = false;
	private readonly expression: RegExp;
	/**
	 * Code units a match attempt can read: two per query code unit covers case folding into surrogate pairs. An attempt
	 * starting this far before a change read only unchanged text.
	 */
	private readonly reach: number;
	private starts: number[] = [];
	private ends: number[] = [];
	/** Where the scan continues. */
	private scanFrom = 0;
	/** The text the scan reads, from `start` to the end of the corpus as it was. */
	private window: { start: number; text: string } | undefined;

	constructor(normalizedQuery: string) {
		this.expression = new RegExp(escapeRegExp(normalizedQuery), "giu");
		this.reach = 2 * normalizedQuery.length;
	}

	/** How far the scan got, from 0 to 1. */
	progress(corpus: SearchCorpus): number {
		return this.complete || corpus.textLength === 0 ? 1 : this.scanFrom / corpus.textLength;
	}

	/** The corpus text from `position` on may have changed: keep only the matches decided before it. */
	invalidateFrom(position: number): void {
		let kept = this.starts.length;
		while (kept > 0 && this.starts[kept - 1] + this.reach > position) kept--;
		this.matches = this.matches.slice(0, kept);
		this.starts.length = kept;
		this.ends.length = kept;
		this.scanFrom = kept > 0 ? this.ends[kept - 1] : 0;
		this.window = undefined;
		this.complete = false;
	}

	/** Scan the complete corpus until done or `deadline`; returns whether every match is found. */
	step(corpus: SearchCorpus, deadline: number): boolean {
		if (this.complete) return true;
		this.window ??= { start: this.scanFrom, text: corpus.textFrom(this.scanFrom) };
		const { start, text } = this.window;
		const expression = this.expression;
		const spans = corpus.spans;
		expression.lastIndex = this.scanFrom - start;
		let spanIndex = spans.firstEndingAfter(this.scanFrom);
		let found = 0;
		for (;;) {
			const match = expression.exec(text);
			if (!match) {
				this.complete = true;
				this.window = undefined;
				this.scanFrom = start + text.length;
				return true;
			}
			const from = start + match.index;
			const to = from + match[0].length;
			if (to === from) expression.lastIndex++;
			while (spanIndex < spans.length && spans.textEnd(spanIndex) <= from) spanIndex++;
			const segments: AltScreenSearchSegment[] = [];
			for (let index = spanIndex; index < spans.length; index++) {
				const textStart = spans.textStart(index);
				if (textStart >= to) break;
				const textEnd = spans.textEnd(index);
				if (textEnd <= from) continue;
				const linear = spans.linear(index);
				const spanStartCol = spans.startCol(index);
				const startCol = linear ? spanStartCol + Math.max(from, textStart) - textStart : spanStartCol;
				const endCol = linear ? spanStartCol + Math.min(to, textEnd) - textStart : spans.endCol(index);
				const row = spans.row(index);
				const previous = segments[segments.length - 1];
				if (previous && previous.row === row && startCol <= previous.endCol) {
					previous.endCol = Math.max(previous.endCol, endCol);
				} else segments.push({ row, startCol, endCol });
			}
			while (spanIndex < spans.length && spans.textEnd(spanIndex) <= to) spanIndex++;
			if (segments.length > 0) {
				this.matches.push({ segments });
				this.starts.push(from);
				this.ends.push(to);
			}
			this.scanFrom = Math.max(to, start + expression.lastIndex);
			if (++found % MATCHES_PER_CLOCK_READ === 0 && performance.now() >= deadline) return false;
		}
	}
}
