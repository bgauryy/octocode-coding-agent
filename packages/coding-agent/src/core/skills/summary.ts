/** The longest summary a listing line carries. */
export const SKILL_SUMMARY_CHARS = 120;

const LOAD_FIRST = /^Load this skill first (?:only )?when /;
const FIRST_SENTENCE = /(?<=[a-z)`])\. (?=[A-Z])/;
const CLAUSE_BREAK = /, |; |: | \(| or | and /g;

/**
 * The part of a skill's description the `skill` tool lists: its first sentence, cut when it still exceeds
 * `SKILL_SUMMARY_CHARS` at the last clause break (comma, semicolon, colon, "or", "and", or a parenthesis opening) in its
 * second half that leaves parentheses balanced, else at the last such word break, so no line ends mid-clause or inside
 * an open parenthesis. The full description stays in the skill's file and in what loading it returns.
 */
export function skillSummary(description: string): string {
	const text = (description.split(FIRST_SENTENCE)[0] ?? description).replace(LOAD_FIRST, "Use when ");
	if (text.length <= SKILL_SUMMARY_CHARS) return text;
	const head = text.slice(0, SKILL_SUMMARY_CHARS);
	const clause = lastBalanced(
		head,
		[...head.matchAll(CLAUSE_BREAK)].map((match) => match.index),
	);
	if (clause > SKILL_SUMMARY_CHARS / 2) return head.slice(0, clause);
	const word = lastBalanced(
		head,
		[...head.matchAll(/ /g)].map((match) => match.index),
	);
	return head.slice(0, word > 0 ? word : head.lastIndexOf(" ") > 0 ? head.lastIndexOf(" ") : undefined);
}

/** The last of `cuts` before which parentheses are balanced, or -1. */
function lastBalanced(text: string, cuts: number[]): number {
	for (let i = cuts.length - 1; i >= 0; i--) if (balanced(text.slice(0, cuts[i]))) return cuts[i];
	return -1;
}

function balanced(text: string): boolean {
	return text.split("(").length === text.split(")").length;
}
