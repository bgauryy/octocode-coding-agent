/**
 * Keyless providers (scraped result pages) can answer a bot-like request with decoys: a portal's front page, a list of
 * unrelated popular links. A hit counts as related when its title, snippet or URL shares a significant word of the query.
 */

/** Common words that say nothing about what a page covers. */
const COMMON = new Set(
	"the and for with what how why who when where which are was were is not you your from this that into about does can its has have use using".split(
		" ",
	),
);

/**
 * The query's significant words, lower case and cut to a stem: operators, short and common words left out. A query of
 * only common words is one phrase term, unstemmed; an operator-only or short-word query has no terms.
 */
export function queryTerms(query: string): string[] {
	const words = query
		.split(/\s+/)
		.filter((word) => !/^-|^[a-z]+:/i.test(word))
		.flatMap((word) => word.toLowerCase().split(/[^\p{L}\p{N}]+/u));
	const terms = words.filter((word) => !COMMON.has(word) && (word.length >= 3 || /[^\x00-\x7f]/.test(word)));
	// Only common words (`what is the`) still say something as a phrase: no term would let every hit through.
	const spoken = words.filter(Boolean);
	if (terms.length === 0 && spoken.length > 0 && spoken.every((word) => COMMON.has(word))) return [spoken.join(" ")];
	return [...new Set(terms.map((word) => (word.length > 5 ? word.slice(0, -2) : word)))];
}

/** Whether a hit names one of the terms; with no terms every hit counts. */
export function relatedHit(terms: readonly string[], hit: { title: string; url: string; snippet: string }): boolean {
	if (terms.length === 0) return true;
	const text = `${hit.title} ${hit.snippet} ${safeDecode(hit.url)}`.toLowerCase();
	return terms.some((term) => text.includes(term));
}

function safeDecode(url: string): string {
	try {
		return decodeURI(url);
	} catch {
		return url;
	}
}
