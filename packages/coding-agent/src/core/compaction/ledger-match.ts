/**
 * When a summary's new ledger bullet only restates one already there (`ledger.ts`). A summarizer that does not reuse a
 * bullet's id writes the rule again in other words; counting that as a new rule grows the ledger by every paraphrase,
 * every cycle. A new bullet restates another when it says nothing the other does not: the same polarity (both forbid
 * or neither does), no name the other lacks (a number, a path, an id: `src/file2.ts` and `src/file1.ts` are different
 * rules), at least `CONTAINED` of its words in the other, and the two not so far apart in length that a short bullet's
 * words are merely scattered through a long one (`OVERLAP_FLOOR`).
 */

/**
 * The share of the new bullet's words the other must hold. A new bullet that adds more than a fifth of new words is
 * kept: a grouped bullet that restates a carried rule and adds another must not lose the new one.
 */
const CONTAINED = 0.8;
/** The least overlap (Jaccard) of the two word sets. */
const OVERLAP_FLOOR = 0.3;

/** Words too common to tell two rules apart. Negations are not among them: they decide what a rule says. */
const COMMON = new Set(
	(
		"the and for with are but this that from into only when what which their there than then them they was were will " +
		"would should could have has had been being any all its our your you via per each also must may can use using"
	).split(" "),
);

/** A word that turns a rule around: "never commit" and "commit" are different rules however alike their words. */
const NEGATION = /\b(?:no|not|never|nor|none|without|avoid|forbidden|cannot)\b|n['’]t\b/i;

export interface Words {
	words: ReadonlySet<string>;
	/** The names in it: each token with a digit, a slash or an inner dot ("$25", `M21`, `src/file2.ts`, `v1.2`). */
	names: ReadonlySet<string>;
	negated: boolean;
}

/**
 * The words of `text` compared for a restatement: lower-case words of three letters or more, common words dropped and
 * a plural or tense ending stripped, and its names, which count as words too.
 */
export function wordsOf(text: string): Words {
	const words = new Set<string>();
	const names = new Set<string>();
	for (const [raw] of text
		.normalize("NFKC")
		.toLowerCase()
		.matchAll(/[\p{L}\p{N}_][\p{L}\p{N}_./-]*/gu)) {
		const token = raw.replace(/[./-]+$/, "");
		if (/\d|\/|\w\.\w/.test(token)) {
			names.add(token);
			words.add(token);
			continue;
		}
		for (const [word] of token.matchAll(/[\p{L}_]{3,}/gu))
			if (!COMMON.has(word)) words.add(word.replace(/(?:ing|ed|es|s)$/, "") || word);
	}
	return { words, names, negated: NEGATION.test(text) };
}

/** Whether the new bullet `added` only restates `other` (see above). */
export function restates(added: Words, other: Words): boolean {
	if (added.negated !== other.negated || added.words.size === 0) return false;
	for (const name of added.names) if (!other.names.has(name)) return false;
	let shared = 0;
	for (const word of added.words) if (other.words.has(word)) shared++;
	const union = added.words.size + other.words.size - shared;
	return shared / added.words.size >= CONTAINED && shared / union >= OVERLAP_FLOOR;
}
