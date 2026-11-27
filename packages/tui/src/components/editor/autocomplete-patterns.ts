import { autocompleteBoundaryRegex, autocompleteSeparatorRegex, isWhitespaceChar } from "../../utils/chars.ts";
import type { SelectListLayoutOptions } from "../select-list.ts";

export const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

// Long enough that a typed word ranks once, not once per key; ranking yields to typed keys either way.
export const ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS = 60;
export const DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS = ["@", "#"];
// Unquoted completions end at whitespace or CJK punctuation; quoted paths may contain either.
const unquotedAutocompleteSuffixRegex = new RegExp(`(?:(?!${autocompleteSeparatorRegex.source}).)*`, "u");
// Trigger tokens may be wrapped in prose, e.g. "(@src/foo" or "`@src/foo".
const autocompleteTokenStartSource = `${autocompleteBoundaryRegex.source}[([{<\`]*`;

function escapeCharacterClass(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&");
}

const isAsciiSpace = (code: number): boolean => code === 32 || (code >= 9 && code <= 13);

/** Start of the code point that ends at `end - 1` (a surrogate pair counts as one). */
function codePointStart(text: string, end: number): number {
	const low = text.charCodeAt(end - 1);
	if (low < 0xdc00 || low > 0xdfff || end < 2) return end - 1;
	const high = text.charCodeAt(end - 2);
	return high >= 0xd800 && high <= 0xdbff ? end - 2 : end - 1;
}

/** Index of the last separator (whitespace or CJK punctuation) that starts before `end`, or -1. */
function lastSeparatorBefore(text: string, end: number): number {
	for (let i = end; i > 0;) {
		const code = text.charCodeAt(i - 1);
		if (code < 0x80) {
			if (isAsciiSpace(code)) return i - 1;
			i--;
			continue;
		}
		const start = codePointStart(text, i);
		if (autocompleteSeparatorRegex.test(text.slice(start, i))) return start;
		i = start;
	}
	return -1;
}

/**
 * An end-anchored token pattern tested on the token being typed instead of the whole line, so a key costs the token's
 * length, not the line's. The text is cut at the last separator before the token, or before its open `@"` quote (a
 * quoted path may hold spaces): the pattern's boundary consumes that separator as it would in the whole line, and no
 * match starts earlier. When a trigger character is itself a separator the whole text is tested.
 */
export class TokenPattern {
	readonly regex: RegExp;
	private readonly cut: boolean;

	constructor(regex: RegExp, triggerCharacters: readonly string[]) {
		this.regex = regex;
		this.cut = !triggerCharacters.some((character) => autocompleteSeparatorRegex.test(character));
	}

	/** The end of `text` the pattern can match; `quote` is the index of its last `"` when the caller knows it. */
	tail(text: string, quote = this.cut ? text.lastIndexOf('"') : -1): string {
		if (!this.cut) return text;
		const start = lastSeparatorBefore(text, quote === -1 ? text.length : quote);
		return start <= 0 ? text : text.slice(start);
	}

	test(text: string, quote?: number): boolean {
		return this.regex.test(this.tail(text, quote));
	}

	/** The match at the end of `text`; only its text is meaningful (its index is relative to the tail). */
	exec(text: string): RegExpExecArray | null {
		return this.regex.exec(this.tail(text));
	}
}

export function buildTriggerPattern(triggerCharacters: string[]): TokenPattern {
	return new TokenPattern(
		new RegExp(
			`${autocompleteTokenStartSource}(?:@"[^"]*|[${triggerCharacters.map(escapeCharacterClass).join("")}]${unquotedAutocompleteSuffixRegex.source})$`,
			"u",
		),
		triggerCharacters,
	);
}

export function buildDebouncePattern(triggerCharacters: string[]): TokenPattern {
	const escapedWithoutAt = triggerCharacters.filter((character) => character !== "@").map(escapeCharacterClass);
	return new TokenPattern(
		new RegExp(
			`${autocompleteTokenStartSource}(?:@(?:"[^"]*|${unquotedAutocompleteSuffixRegex.source})|[${escapedWithoutAt.join("")}]${unquotedAutocompleteSuffixRegex.source})$`,
			"u",
		),
		triggerCharacters,
	);
}

const isSpaceAt = (text: string, index: number): boolean => {
	const code = text.charCodeAt(index);
	return code < 0x80 ? isAsciiSpace(code) : isWhitespaceChar(text[index]);
};

/** True while `text` ends in a `/name` token after whitespace or the start: `(?:^|\s)\/[^\s/]*$`, read backwards. */
export function endsInSlashToken(text: string): boolean {
	for (let i = text.length - 1; i >= 0; i--) {
		if (text[i] === "/") return i === 0 || isSpaceAt(text, i - 1);
		if (isSpaceAt(text, i)) return false;
	}
	return false;
}

/** True right after a `/` that follows whitespace or the start: `(?:^|\s)\/$`. */
export function endsInSlash(text: string): boolean {
	const last = text.length - 1;
	return text[last] === "/" && (last === 0 || isSpaceAt(text, last - 1));
}

/**
 * Find the best autocomplete item index for the given prefix.
 * Returns -1 if no match is found.
 *
 * Match priority:
 * 1. Exact match (prefix === item.value) -> always selected
 * 2. Prefix match -> first item whose value starts with prefix
 * 3. No match -> -1 (keep default highlight)
 *
 * Matching is case-sensitive and checks item.value only.
 */
export function getBestAutocompleteMatchIndex(items: Array<{ value: string; label: string }>, prefix: string): number {
	if (!prefix) return -1;

	let firstPrefixIndex = -1;

	for (let i = 0; i < items.length; i++) {
		const value = items[i].value;
		if (value === prefix) {
			return i; // Exact match always wins
		}
		if (firstPrefixIndex === -1 && value.startsWith(prefix)) {
			firstPrefixIndex = i;
		}
	}

	return firstPrefixIndex;
}
