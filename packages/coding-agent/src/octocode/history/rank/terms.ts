import { escapeRegExp } from "@octocodeai/octocode-common/regexp";

/**
 * How ranked search (`../rank.ts`) reads text: words, their terms (lowercased, lightly stemmed, identifiers split) and
 * the passages a file is cut into. The archive index (`../index/`) stores what these produce, so any change to them
 * must raise `TOKENIZER_VERSION`, which rebuilds the index.
 */

/** Raise whenever `stem`, `wordTerms`, `WORD`, `BOUNDARY`, `PASSAGE_LINES` or the ranked-text rules change. */
export const TOKENIZER_VERSION = 1;

export const PASSAGE_LINES = 40;
export const WORD = /[\p{L}\p{N}]+(?:[._\-/][\p{L}\p{N}]+)*/gu;
export const BOUNDARY = /^(?:#{1,4} |Tool `)/;
const STOPWORDS = new Set(
	"a an and are as at be by did do does for from how i in is it of on or our that the this to was we were what when where which who why with you".split(
		" ",
	),
);

/** The shared root of a word's inflections: failing, failed and fails are `fail`; queries is `query`; caches is `cach`. */
export function stem(word: string): string {
	let w = word;
	if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
	else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
	else if (w.length > 4 && (w.endsWith("ed") || w.endsWith("es"))) w = w.slice(0, -2);
	else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
	return w.length > 4 && w.endsWith("e") ? w.slice(0, -1) : w;
}

/** The terms one word stands for: itself and, for an identifier or path, each part, all stemmed and lowercased. */
export function wordTerms(word: string): string[] {
	const whole = stem(word.toLowerCase());
	if (!/[._\-/]|.\p{Lu}/u.test(word)) return [whole];
	const parts = word
		.split(/[._\-/]+/)
		.flatMap((part) => part.split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u))
		.filter(Boolean)
		.map((part) => stem(part.toLowerCase()));
	return [...new Set([whole, ...parts])];
}

/** Distinct words whose terms are kept; past it the memo starts over (a whole archive has about 250,000). */
const MEMO_WORDS = 300_000;
const memo = new Map<string, readonly string[]>();

/** `wordTerms`, remembered: the same few words repeat across a whole archive. The result must not be changed. */
export function termsOf(word: string): readonly string[] {
	let terms = memo.get(word);
	if (terms === undefined) {
		if (memo.size >= MEMO_WORDS) memo.clear();
		terms = wordTerms(word);
		memo.set(word, terms);
	}
	return terms;
}

export interface Query {
	terms: string[];
	/** Lowercased quoted phrases. */
	phrases: string[];
	/** Each term as it was typed (lowercased), for messages: a stem such as `kerbero` would read as a typo. */
	labels: Map<string, string>;
}

/** `keywords` as query terms (stopwords dropped unless nothing else is left) and its quoted phrases. */
export function parseKeywords(keywords: string): Query {
	const phrases = [...keywords.matchAll(/"([^"]+)"/g)].map((match) => match[1].trim().toLowerCase()).filter(Boolean);
	const words = keywords.match(WORD) ?? [];
	const kept = words.filter((word) => !STOPWORDS.has(word.toLowerCase()));
	const chosen = kept.length > 0 ? kept : words;
	const terms = [...new Set(chosen.flatMap(wordTerms))];
	const labels = new Map<string, string>();
	for (const word of chosen) {
		const parts = word.split(/[._\-/]+|(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u).filter(Boolean);
		for (const typed of [word, ...parts]) {
			const term = stem(typed.toLowerCase());
			if (!labels.has(term)) labels.set(term, typed.toLowerCase());
		}
	}
	return { terms, phrases, labels };
}

const escape = (text: string) => escapeRegExp(text).replace(/[σς]/g, "[σς]");

/**
 * A test that passes for every lowercased text holding a word with one of `terms`, so only such text needs the
 * word-by-word count. A term is a prefix of the lowercased word or identifier part it came from, except where `stem`
 * turns `ies` into `y`; σ and ς are interchangeable, since lowercasing picks the final form by the letter after it.
 */
export function termTest(terms: readonly string[]): RegExp {
	const alternatives = terms.map((term) =>
		term.endsWith("y") ? `${escape(term.slice(0, -1))}(?:y|ie)` : escape(term),
	);
	return new RegExp(alternatives.join("|"), "u");
}
