import { autocompleteBoundaryRegex, autocompleteSeparatorRegex } from "../../utils/chars.ts";
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

export function buildTriggerPattern(triggerCharacters: string[]): RegExp {
	return new RegExp(
		`${autocompleteTokenStartSource}(?:@"[^"]*|[${triggerCharacters.map(escapeCharacterClass).join("")}]${unquotedAutocompleteSuffixRegex.source})$`,
		"u",
	);
}

export function buildDebouncePattern(triggerCharacters: string[]): RegExp {
	const escapedWithoutAt = triggerCharacters.filter((character) => character !== "@").map(escapeCharacterClass);
	return new RegExp(
		`${autocompleteTokenStartSource}(?:@(?:"[^"]*|${unquotedAutocompleteSuffixRegex.source})|[${escapedWithoutAt.join("")}]${unquotedAutocompleteSuffixRegex.source})$`,
		"u",
	);
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
