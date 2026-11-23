import { eastAsianWidth } from "get-east-asian-width";
import { ansiCodeLength } from "./ansi-codes.ts";

/**
 * An `Intl.Segmenter` made on first use. The first segmenter a process makes loads ICU's break data (about 10 ms), so
 * none is made while modules load; one shared instance per granularity serves every caller.
 */
function lazySegmenter(granularity: "grapheme" | "word"): Intl.Segmenter {
	let segmenter: Intl.Segmenter | undefined;
	const get = (): Intl.Segmenter => (segmenter ??= new Intl.Segmenter(undefined, { granularity }));
	return { segment: (input) => get().segment(input), resolvedOptions: () => get().resolvedOptions() };
}

export const graphemeSegmenter: Intl.Segmenter = lazySegmenter("grapheme");
const wordSegmenter = lazySegmenter("word");

/** The shared grapheme segmenter. */
export function getGraphemeSegmenter(): Intl.Segmenter {
	return graphemeSegmenter;
}

/** The shared word segmenter. */
export function getWordSegmenter(): Intl.Segmenter {
	return wordSegmenter;
}

/**
 * Check if a grapheme cluster (after segmentation) could possibly be an RGI emoji.
 * This is a fast heuristic to avoid the expensive rgiEmojiRegex test.
 * The tested Unicode blocks are deliberately broad to account for future
 * Unicode additions.
 */
function couldBeEmoji(segment: string): boolean {
	const cp = segment.codePointAt(0)!;
	return (
		(cp >= 0x1f000 && cp <= 0x1fbff) || // Emoji and Pictograph
		(cp >= 0x2300 && cp <= 0x23ff) || // Misc technical
		(cp >= 0x2600 && cp <= 0x27bf) || // Misc symbols, dingbats
		(cp >= 0x2b50 && cp <= 0x2b55) || // Specific stars/circles
		segment.includes("\uFE0F") || // Contains VS16 (emoji presentation selector)
		segment.length > 2 // Multi-codepoint sequences (ZWJ, skin tones, etc.)
	);
}

// Regexes for character classification (same as string-width library)
const zeroWidthRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v;
const leadingNonPrintingRegex = /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
const nonPrintingCharRegex = /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})$/v;
const markCharRegex = /^\p{Mark}$/v;
// Marks that terminals allocate cells for when attached to a base character.
// This includes Unicode spacing marks and non-spacing exceptions in legacy wcwidth tables.
const terminalSpacingMarkRegex =
	/^(?:[\p{Spacing_Mark}--[\u1734\u302E\u302F]]|[\u065F\u0F7F\u102B\u102C\u1031\u1033-\u1035\u1038\u103A-\u103E])+$/v;
// Made on first use, like the segmenters.
let rgiEmojiRegex: RegExp | undefined;
const isRgiEmoji = (segment: string): boolean => (rgiEmojiRegex ??= /^\p{RGI_Emoji}$/v).test(segment);

/**
 * Widths of strings measured recently. A row is measured again by the passes that handle it one after the other
 * (wrapping, padding, framing, finishing), so the same string is asked about again within a short span: a small cache
 * answers those. It starts over when full rather than evicting one entry per insert: a long result measured row by row
 * never repeats a row, and evicting for each of them cost several times the measuring. Strings of
 * `WIDTH_CACHE_MIN_LENGTH` or more are kept; shorter ASCII strings cost less to scan than to look up, shorter
 * non-ASCII strings are kept anyway (segmenting is slow). Strings over `WIDTH_CACHE_MAX_LENGTH` are not kept, which
 * bounds the cache's memory.
 */
const WIDTH_CACHE_SIZE = 512;
const WIDTH_CACHE_MIN_LENGTH = 24;
const WIDTH_CACHE_MAX_LENGTH = 1024;
const widthCache = new Map<string, number>();

/** Drop every cached width: the rows measured at a size that no longer applies will not be asked about again. */
export function clearWidthCache(): void {
	widthCache.clear();
}

function rememberWidth(str: string, width: number): void {
	if (str.length > WIDTH_CACHE_MAX_LENGTH) return;
	if (widthCache.size >= WIDTH_CACHE_SIZE) widthCache.clear();
	widthCache.set(str, width);
}

export function isPrintableAscii(str: string): boolean {
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) {
			return false;
		}
	}
	return true;
}

/**
 * Calculate the terminal width of a single grapheme cluster.
 * Based on code from the string-width library, but includes a possible-emoji
 * check to avoid running the RGI_Emoji regex unnecessarily.
 */
export function graphemeWidth(segment: string): number {
	if (segment.length === 1) {
		const code = segment.charCodeAt(0);
		if (code >= 0x20 && code <= 0x7e) return 1;
		if (code === 0x09) return 3;
	}

	// Some marks occupy cells even without a base character.
	if (terminalSpacingMarkRegex.test(segment)) {
		// oxlint-disable-next-line typescript/no-misused-spread -- counts code points inside one grapheme on purpose
		return [...segment].length;
	}

	if (zeroWidthRegex.test(segment)) {
		return 0;
	}

	// Emoji check with pre-filter
	if (couldBeEmoji(segment) && isRgiEmoji(segment)) {
		return 2;
	}

	// Get base visible codepoint
	const base = segment.replace(leadingNonPrintingRegex, "");
	const cp = base.codePointAt(0);
	if (cp === undefined) {
		return 0;
	}

	// Regional indicator symbols (U+1F1E6..U+1F1FF) are often rendered as
	// full-width emoji in terminals, even when isolated during streaming.
	// Keep width conservative (2) to avoid terminal auto-wrap drift artifacts.
	if (cp >= 0x1f1e6 && cp <= 0x1f1ff) {
		return 2;
	}

	let width = eastAsianWidth(cp);

	// Intl.Segmenter can group multiple terminal-spacing code points into one
	// grapheme. Count trailing visible code points that terminals may allocate
	// cells for: Indic consonants after marks, halfwidth/fullwidth forms, and
	// Thai/Lao AM vowels.
	let followsMark = false;
	// oxlint-disable-next-line typescript/no-misused-spread -- walks code points inside one grapheme on purpose
	const chars = [...base];
	for (const char of chars.slice(1)) {
		if (terminalSpacingMarkRegex.test(char)) {
			width += 1;
			followsMark = false;
		} else if (markCharRegex.test(char)) {
			followsMark = true;
		} else if (!nonPrintingCharRegex.test(char)) {
			const c = char.codePointAt(0)!;
			if (followsMark || (c >= 0xff00 && c <= 0xffef)) {
				// halfwidth + fullwidth forms
				width += eastAsianWidth(c);
			} else if (c === 0x0e33 || c === 0x0eb3) {
				width += 1;
			}
			followsMark = false;
		}
	}

	return width;
}

/**
 * Calculate the visible width of a string in terminal columns.
 */
export function visibleWidth(str: string): number {
	if (str.length === 0) {
		return 0;
	}

	const cacheable = str.length >= WIDTH_CACHE_MIN_LENGTH;
	if (cacheable) {
		const cached = widthCache.get(str);
		if (cached !== undefined) return cached;
	}

	// Fast path: printable ASCII, tabs, and ANSI escape sequences. Styled lines take this path, so
	// re-rendering after a theme change does not run grapheme segmentation on every line.
	const asciiWidth = asciiVisibleWidth(str);
	if (asciiWidth !== -1) {
		if (cacheable) rememberWidth(str, asciiWidth);
		return asciiWidth;
	}

	if (str.length === 1) {
		const single = standaloneWidth(str.charCodeAt(0));
		if (single !== -1) return single;
	}

	if (!cacheable) {
		const cached = widthCache.get(str);
		if (cached !== undefined) return cached;
	}

	// Normalize: tabs to 3 spaces, strip ANSI escape codes
	let clean = str;
	if (str.includes("\t")) {
		clean = clean.replace(/\t/g, "   ");
	}
	let escapeIndex = clean.indexOf("\x1b");
	if (escapeIndex !== -1) {
		// Strip supported ANSI/OSC/APC escape sequences in one pass.
		// This covers CSI styling/cursor codes, OSC hyperlinks and prompt markers,
		// and APC sequences like CURSOR_MARKER.
		let stripped = "";
		let copyFrom = 0;
		while (escapeIndex !== -1) {
			const length = ansiCodeLength(clean, escapeIndex);
			if (length > 0) {
				stripped += clean.slice(copyFrom, escapeIndex);
				escapeIndex += length;
				copyFrom = escapeIndex;
			} else {
				escapeIndex++;
			}
			escapeIndex = clean.indexOf("\x1b", escapeIndex);
		}
		clean = stripped + clean.slice(copyFrom);
	}

	let width = 0;
	let i = 0;
	while (i < clean.length) {
		const single = singleCharWidth(clean, i);
		if (single !== -1) {
			width += single;
			i++;
			continue;
		}
		const end = segmentedRunEnd(clean, i);
		width += segmentedRun(clean.slice(i, end)).width;
		i = end;
	}

	rememberWidth(str, width);

	return width;
}

/**
 * Width of a string made of printable ASCII, tabs, and ANSI escape sequences, or -1 if it contains
 * anything else. Matches `visibleWidth` for those strings without allocating.
 */
function asciiVisibleWidth(str: string): number {
	let width = 0;
	let i = 0;
	while (i < str.length) {
		const code = str.charCodeAt(i);
		if (code >= 0x20 && code <= 0x7e) {
			width++;
			i++;
		} else if (code === 0x09) {
			width += 3;
			i++;
		} else if (code === 0x1b) {
			const length = ansiCodeLength(str, i);
			if (length === 0) return -1;
			i += length;
		} else {
			return -1;
		}
	}
	return width;
}

/**
 * Symbols and letters below U+3000 that are a grapheme of their own whatever text surrounds them (Grapheme_Cluster_Break
 * Other: no mark, joiner, format or control character, Prepend or Hangul jamo among them): Latin-1 to IPA without the
 * soft hyphen, Greek and Cyrillic without the combining marks, general punctuation without the zero-width, bidi and
 * line-separator characters, and the symbol blocks from super- and subscripts through CJK radicals (arrows, box
 * drawing, blocks, shapes, dingbats, braille). `test/width-standalone.test.ts` checks every one against the segmenter.
 */
const STANDALONE_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x00a0, 0x00ac],
	[0x00ae, 0x02ff],
	[0x0370, 0x0482],
	[0x048a, 0x052f],
	[0x2010, 0x2027],
	[0x2030, 0x205e],
	[0x2070, 0x20cf],
	[0x2100, 0x2bff],
	[0x2e00, 0x2fff],
];
/** `standaloneWidth` of each code unit below U+3000 plus two (-1 for one that is not standalone), filled on first use; 0 is not yet known. */
const standaloneWidths = new Int8Array(0x3000);

function isStandaloneBelowCjk(code: number): boolean {
	for (const [from, to] of STANDALONE_RANGES) {
		if (code < from) return false;
		if (code <= to) return true;
	}
	return false;
}

/**
 * Width of a code unit that is a grapheme of its own whatever text surrounds it, -1 for any other: printable ASCII,
 * `STANDALONE_RANGES`, and the CJK, kana, Hangul syllable and fullwidth characters, none of which is a mark, a joiner or
 * a surrogate. Two such characters in a row always have a grapheme break between them (no Prepend or CR among them), so
 * text made of them needs no segmenter, which costs most of the time of measuring and wrapping such text. A width is
 * the one `graphemeWidth` gives the character alone, so it matches the segmenting path.
 */
function standaloneWidth(code: number): number {
	if (code >= 0x20 && code <= 0x7e) return 1;
	if (code < 0x3000) {
		const known = standaloneWidths[code];
		if (known !== 0) return known - 2;
		const width = isStandaloneBelowCjk(code) ? graphemeWidth(String.fromCharCode(code)) : -1;
		standaloneWidths[code] = width + 2;
		return width;
	}
	// East Asian Width Wide or Fullwidth throughout.
	if (
		(code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
		(code >= 0x3041 && code <= 0x3096) || // Hiragana
		(code >= 0x309b && code <= 0x30ff) || // Katakana
		(code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
		(code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
		(code >= 0xff01 && code <= 0xff60) || // fullwidth forms
		(code >= 0xffe0 && code <= 0xffe6)
	)
		return 2;
	// CJK symbols and punctuation without the tone marks, and unassigned kana before the combining sound marks: these
	// widths vary.
	if ((code >= 0x3000 && code <= 0x3029) || (code >= 0x3030 && code <= 0x3040) || code === 0x3097 || code === 0x3098)
		return eastAsianWidth(code);
	return -1;
}

/** Width of the code unit at `i` when it is a grapheme of its own here: standalone, and so is the next one. */
function singleCharWidth(text: string, i: number): number {
	const width = standaloneWidth(text.charCodeAt(i));
	if (width === -1 || i + 1 === text.length || standaloneWidth(text.charCodeAt(i + 1)) !== -1) return width;
	return -1;
}

/**
 * End of the run from `start` that needs the segmenter: up to and including the first standalone character followed by
 * another standalone character or the end of the text, where a grapheme break is certain. The character before `start`
 * is standalone and so is `start`'s own, or `start` is where a previous run ended, so a break precedes `start` too.
 */
function segmentedRunEnd(text: string, start: number): number {
	for (let j = start + 1; j < text.length; j++) {
		if (standaloneWidth(text.charCodeAt(j)) === -1) continue;
		if (j + 1 === text.length || standaloneWidth(text.charCodeAt(j + 1)) !== -1) return j + 1;
	}
	return text.length;
}

interface SegmentedRun {
	readonly segments: readonly string[];
	readonly width: number;
}

/**
 * Runs segmented recently. Each `Intl.Segmenter` call has a fixed cost larger than segmenting a short run, and the same
 * runs (an emoji and the space after it, an accented word) recur across the rows of a transcript. Bounded like
 * `widthCache`: it starts over when full, and long runs are not kept.
 */
const RUN_CACHE_SIZE = 1024;
const RUN_CACHE_MAX_LENGTH = 64;
const runCache = new Map<string, SegmentedRun>();

function segmentedRun(run: string): SegmentedRun {
	const cached = runCache.get(run);
	if (cached) return cached;
	const segments: string[] = [];
	let width = 0;
	for (const { segment } of graphemeSegmenter.segment(run)) {
		segments.push(segment);
		width += graphemeWidth(segment);
	}
	const result = { segments, width };
	if (run.length <= RUN_CACHE_MAX_LENGTH) {
		if (runCache.size >= RUN_CACHE_SIZE) runCache.clear();
		runCache.set(run, result);
	}
	return result;
}

/** The grapheme clusters of `text`, as `Intl.Segmenter` splits them, segmenting only the runs that need it. */
export function* graphemeSegments(text: string): Generator<string> {
	let i = 0;
	while (i < text.length) {
		if (singleCharWidth(text, i) !== -1) {
			yield text[i];
			i++;
			continue;
		}
		const end = segmentedRunEnd(text, i);
		yield* segmentedRun(text.slice(i, end)).segments;
		i = end;
	}
}
