/** The longest summary a listing line carries. */
export const SKILL_SUMMARY_CHARS = 120;

const LOAD_FIRST = /^Load this skill first (?:only )?when /;
const FIRST_SENTENCE = /(?<=[a-z)`])\. (?=[A-Z])/;

/**
 * The part of a skill's description the `skill` tool lists: its first sentence, cut at the last clause break (comma,
 * semicolon, colon, or a parenthesis opening) that leaves parentheses balanced when it still exceeds `SKILL_SUMMARY_CHARS`.
 * The full description stays in the skill's file and in what loading it returns.
 */
export function skillSummary(description: string): string {
	let text = (description.split(FIRST_SENTENCE)[0] ?? description).replace(LOAD_FIRST, "Use when ");
	if (text.length > SKILL_SUMMARY_CHARS) {
		const head = text.slice(0, SKILL_SUMMARY_CHARS);
		const cuts = [", ", "; ", ": ", " ("]
			.map((mark) => head.lastIndexOf(mark))
			.filter((at) => at > SKILL_SUMMARY_CHARS / 2 && balanced(head.slice(0, at)));
		text =
			cuts.length > 0
				? head.slice(0, Math.max(...cuts))
				: head.slice(0, head.lastIndexOf(" ") > 0 ? head.lastIndexOf(" ") : undefined);
	}
	return text;
}

function balanced(text: string): boolean {
	return text.split("(").length === text.split(")").length;
}
