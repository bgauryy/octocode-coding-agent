import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { MemoryError } from "./errors.ts";

/** The longest `query` regular expression a memory or session-note search accepts. */
export const PATTERN_MAX = 200;
/** The most characters of one memory or note a pattern is tested against; the rest is not searched. */
const SUBJECT_MAX = 4000;

/** What makes `pattern` able to backtrack exponentially (a quantified group holding a quantifier, a backreference), or undefined. */
function ambiguity(pattern: string): string | undefined {
	// One flag per open group: did a quantifier appear inside it?
	const groups: boolean[] = [];
	let inClass = false;
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern.charAt(i);
		if (ch === "\\") {
			const next = pattern[i + 1] ?? "";
			if (!inClass && (/[1-9]/.test(next) || (next === "k" && pattern[i + 2] === "<"))) return "a backreference";
			i++;
			continue;
		}
		if (inClass) {
			if (ch === "]") inClass = false;
			continue;
		}
		if (ch === "[") inClass = true;
		else if (ch === "(") groups.push(false);
		else if (ch === ")") {
			const inner = groups.pop() ?? false;
			const after = pattern.slice(i + 1);
			const repeats = /^(?:[*+]|\{\d+,\d*\}|\{\d*,\d+\})/.test(after);
			if (repeats && inner) return "a repeated group that itself contains a repeat, such as (a+)+";
			if (repeats && groups.length > 0) groups[groups.length - 1] = true;
			else if (inner && groups.length > 0) groups[groups.length - 1] = true;
		} else if (/[*+]/.test(ch) || (ch === "{" && /^\{\d*,?\d*\}/.test(pattern.slice(i)))) {
			if (groups.length > 0) groups[groups.length - 1] = true;
		}
	}
	return undefined;
}

/**
 * The case-insensitive expression a search `query` names. It runs on the calling thread or a worker with no linear-time
 * engine, so a pattern that is too long, invalid, or able to backtrack exponentially is the caller's error.
 */
export function compileQuery(query: string): RegExp {
	if (query.length > PATTERN_MAX)
		throw new MemoryError(`query is a regular expression of at most ${PATTERN_MAX} characters.`);
	const problem = ambiguity(query);
	if (problem)
		throw new MemoryError(
			`query is rejected: it has ${problem}, which can make the search run for minutes. Use a simpler pattern, or keywords.`,
		);
	try {
		return new RegExp(query, "i");
	} catch (error) {
		throw new MemoryError(
			`query is a regular expression, and this one is invalid, not a valid regular expression (${errorMessage(error)}); escape ( [ . * + ? with a backslash.`,
			{ cause: error },
		);
	}
}

/** `text` cut to what a pattern is tested against. */
export const searchable = (text: string): string => (text.length > SUBJECT_MAX ? text.slice(0, SUBJECT_MAX) : text);
