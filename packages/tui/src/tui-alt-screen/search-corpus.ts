/**
 * The text transcript search runs over: every rendered row's words joined by single spaces, and where each piece of
 * text came from (row and columns). Built row by row, so a change at row `r` keeps the text and spans of the rows
 * before it and rebuilds only the rest; a long transcript is indexed in slices instead of in one blocking pass.
 */

import { stripTerminalSequences } from "../utils/ansi-codes.ts";
import { getGraphemeSegmenter, visibleWidth } from "../utils/width.ts";

const segmenter = getGraphemeSegmenter();
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const WHITESPACE = /^\s+$/u;

/** Fields of one span, stored side by side in one typed array. */
const START = 0;
const END = 1;
const ROW = 2;
const START_COL = 3;
const END_COL = 4;
const LINEAR = 5;
const STRIDE = 6;

/**
 * Where the corpus text came from: text `[textStart, textEnd)` is drawn on `row` from `startCol` to `endCol`. A linear
 * span is ASCII, one column per character, so a match inside it maps to columns by offset.
 */
class SearchSpans {
	private data = new Int32Array(STRIDE * 1024);
	length = 0;

	push(textStart: number, textEnd: number, row: number, startCol: number, endCol: number, linear: boolean): void {
		if ((this.length + 1) * STRIDE > this.data.length) {
			const grown = new Int32Array(this.data.length * 2);
			grown.set(this.data);
			this.data = grown;
		}
		const at = this.length * STRIDE;
		this.data[at + START] = textStart;
		this.data[at + END] = textEnd;
		this.data[at + ROW] = row;
		this.data[at + START_COL] = startCol;
		this.data[at + END_COL] = endCol;
		this.data[at + LINEAR] = linear ? 1 : 0;
		this.length++;
	}

	textStart(index: number): number {
		return this.data[index * STRIDE + START];
	}

	textEnd(index: number): number {
		return this.data[index * STRIDE + END];
	}

	row(index: number): number {
		return this.data[index * STRIDE + ROW];
	}

	startCol(index: number): number {
		return this.data[index * STRIDE + START_COL];
	}

	endCol(index: number): number {
		return this.data[index * STRIDE + END_COL];
	}

	linear(index: number): boolean {
		return this.data[index * STRIDE + LINEAR] === 1;
	}

	/** The first span whose text ends after `position`. */
	firstEndingAfter(position: number): number {
		let low = 0;
		let high = this.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if (this.textEnd(middle) <= position) low = middle + 1;
			else high = middle;
		}
		return low;
	}
}

/** Growable list of row starts. */
class Offsets {
	private data = new Int32Array(1024);

	set(index: number, value: number): void {
		if (index >= this.data.length) {
			const grown = new Int32Array(Math.max(index + 1, this.data.length * 2));
			grown.set(this.data);
			this.data = grown;
		}
		this.data[index] = value;
	}

	get(index: number): number {
		return this.data[index];
	}
}

/** Text the tail holds before it is folded into the head, so a frame's update copies at most this much. */
const TAIL_FOLD_LENGTH = 1 << 20;

export class SearchCorpus {
	readonly spans = new SearchSpans();
	/** Rows indexed so far: rows `[0, rows)`. */
	rows = 0;
	/** Text length and span count where each indexed row starts. */
	private readonly rowText = new Offsets();
	private readonly rowSpan = new Offsets();
	/** The text, as a head that rarely changes and a tail of the rows indexed since the last fold. */
	private head = "";
	private tail: string[] = [];
	private tailLength = 0;

	get textLength(): number {
		return this.head.length + this.tailLength;
	}

	/** Where row `row`'s text starts (`row` ≤ `rows`). */
	textStartOfRow(row: number): number {
		return row >= this.rows ? this.textLength : this.rowText.get(row);
	}

	/** Forget the rows from `row` on. */
	truncate(row: number): void {
		if (row >= this.rows) return;
		const length = this.rowText.get(row);
		this.spans.length = this.rowSpan.get(row);
		this.rows = row;
		if (length >= this.head.length) {
			const kept = this.tailText().slice(0, length - this.head.length);
			this.tail = kept ? [kept] : [];
			this.tailLength = kept.length;
		} else {
			this.head = this.head.slice(0, length);
			this.tail = [];
			this.tailLength = 0;
		}
	}

	/** The text from `position` to the end. */
	textFrom(position: number): string {
		const headLength = this.head.length;
		const tail = this.tailText();
		if (position >= headLength) return tail.slice(position - headLength);
		return this.head.slice(position) + tail;
	}

	private tailText(): string {
		if (this.tail.length > 1) this.tail = [this.tail.join("")];
		return this.tail[0] ?? "";
	}

	private push(text: string): void {
		this.tail.push(text);
		this.tailLength += text.length;
	}

	/** Index `line` as row `rows`. */
	appendRow(rawLine: string | undefined): void {
		const row = this.rows;
		let textLength = this.textLength;
		this.rowText.set(row, textLength);
		this.rowSpan.set(row, this.spans.length);
		// Every row after text ends with a pending separator, so a row starts with one exactly when text came before.
		let pendingSeparator = textLength > 0;
		const appendSeparator = (): void => {
			if (!pendingSeparator) return;
			this.push(" ");
			textLength += 1;
			pendingSeparator = false;
		};
		const line = stripTerminalSequences(rawLine ?? "");
		let column = 0;
		// Rendered transcripts are overwhelmingly ASCII: index whole non-space runs instead of segmenting each cell.
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
				this.push(text);
				this.spans.push(textLength, textLength + text.length, row, column, column + text.length, true);
				textLength += text.length;
				column += text.length;
				index = end;
			}
		} else {
			for (const grapheme of segmenter.segment(line)) {
				const text = grapheme.segment;
				const width = visibleWidth(text);
				if (WHITESPACE.test(text)) {
					if (textLength > 0) pendingSeparator = true;
					column += width;
					continue;
				}
				appendSeparator();
				this.push(text);
				this.spans.push(textLength, textLength + text.length, row, column, column + width, false);
				textLength += text.length;
				column += width;
			}
		}
		this.rows = row + 1;
		if (this.tailLength >= TAIL_FOLD_LENGTH) {
			this.head += this.tailText();
			this.tail = [];
			this.tailLength = 0;
		}
	}
}
