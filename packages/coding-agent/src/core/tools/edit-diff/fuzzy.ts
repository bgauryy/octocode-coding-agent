/**
 * Fuzzy matching for edits: text is normalized only to find where `oldText` sits; the match is mapped back to offsets
 * of the original text, so the written file keeps every original byte outside the matched span.
 */

let graphemesCache: Intl.Segmenter | undefined;
/** Made on first use: a segmenter loads ICU data (about 10 ms), which a process that never needs it should not pay at load. */
const graphemes = (): Intl.Segmenter => (graphemesCache ??= new Intl.Segmenter(undefined, { granularity: "grapheme" }));

/** Per-character folds applied after NFKC: smart quotes, Unicode dashes and special spaces become ASCII. */
function foldCharacters(text: string): string {
	return (
		text
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash, U+2013 en-dash, U+2014 em-dash,
			// U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP, U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

/** `text` normalized for matching (NFKC, folds, no trailing whitespace per line) with, per output character, the original span it came from. */
interface NormalizedText {
	text: string;
	starts: number[];
	ends: number[];
}

function normalizeWithMap(text: string): NormalizedText {
	const out: string[] = [];
	const starts: number[] = [];
	const ends: number[] = [];
	let lineStart = 0;
	const endLine = (): void => {
		// Drop trailing whitespace of the finished line from the output.
		while (out.length > lineStart && /\s/.test(out[out.length - 1])) {
			out.pop();
			starts.pop();
			ends.pop();
		}
	};
	for (const { segment, index } of graphemes().segment(text)) {
		if (segment === "\n") {
			endLine();
			out.push("\n");
			starts.push(index);
			ends.push(index + 1);
			lineStart = out.length;
			continue;
		}
		for (const char of foldCharacters(segment.normalize("NFKC"))) {
			// A character may be several UTF-16 units; every unit maps to the same original span.
			for (let unit = 0; unit < char.length; unit++) {
				out.push(char[unit]);
				starts.push(index);
				ends.push(index + segment.length);
			}
		}
	}
	endLine();
	return { text: out.join(""), starts, ends };
}

function normalizeForFuzzyMatch(text: string): string {
	return normalizeWithMap(text).text;
}

export interface FoundText {
	/** Offset in the original content where the match starts. */
	index: number;
	/** Length of the matched span of the original content. */
	matchLength: number;
	/** Matches of `oldText` after normalization; more than one means the text is not unique. */
	occurrences: number;
}

/** Locate `oldText` in `content`: spelled exactly, else equal after normalization, mapped back to original offsets. */
export function findText(content: string, oldText: string): FoundText | undefined {
	// A verbatim spelling decides first, so an edit that differs only in whitespace (which normalization erases) still
	// resolves, and uniqueness is judged on the exact text the caller wrote.
	const exact = content.indexOf(oldText);
	if (exact !== -1) {
		let exactCount = 1;
		for (
			let at = content.indexOf(oldText, exact + oldText.length);
			at !== -1;
			at = content.indexOf(oldText, at + oldText.length)
		) {
			exactCount++;
		}
		return { index: exact, matchLength: oldText.length, occurrences: exactCount };
	}
	const normalized = normalizeWithMap(content);
	const needle = normalizeForFuzzyMatch(oldText);
	if (needle.length === 0) return undefined;
	let occurrences = 0;
	for (let at = normalized.text.indexOf(needle); at !== -1; at = normalized.text.indexOf(needle, at + needle.length)) {
		occurrences++;
	}
	if (occurrences === 0) return undefined;
	const at = normalized.text.indexOf(needle);
	const index = normalized.starts[at];
	return { index, matchLength: normalized.ends[at + needle.length - 1] - index, occurrences };
}
