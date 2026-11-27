/**
 * Shared diff computation utilities for the edit and similar tools.
 */

import { findText } from "./edit-diff/fuzzy.ts";
import { applyReplacements, type MatchedEdit, type TextReplacement } from "./edit-diff/replacements.ts";
import { mismatchHint } from "./edit-mismatch.ts";

export { generateDiffString, generateUnifiedPatch } from "./edit-diff/display.ts";
export { applyReplacementsToOriginal } from "./edit-diff/replacements.ts";

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export interface Edit {
	oldText: string;
	newText: string;
	replaceAll?: boolean;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
	/**
	 * What turns `baseContent` into `newContent`, at offsets of `baseContent`: `applyReplacementsToOriginal` writes them
	 * into the file's own text, keeping the line endings of the lines they leave alone.
	 */
	replacements: TextReplacement[];
}

function normalizeEditQuotes(text: string): string {
	return text.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"');
}

/** All non-overlapping matches in LF-normalized text; exact spelling wins over quote-only fallback. */
export function findAllEditOccurrences(content: string, oldText: string): number[] {
	if (!oldText.length) return [];
	const exact = content.includes(oldText);
	const haystack = exact ? content : normalizeEditQuotes(content);
	const needle = exact ? oldText : normalizeEditQuotes(oldText);
	const matches: number[] = [];
	for (let from = 0; from <= haystack.length - needle.length;) {
		const index = haystack.indexOf(needle, from);
		if (index < 0) break;
		matches.push(index);
		from = index + needle.length;
	}
	return matches;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number, hint = ""): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.${hint}`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.${hint}`,
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. All-occurrence edits
 * retain original offsets and use exact matches or length-preserving quote fallback.
 * Mixed all-occurrence and broader fuzzy edits are refused. Without all-occurrence
 * edits, an oldText that is not found verbatim is matched after normalization (quotes, dashes, spaces, Unicode
 * compatibility forms, trailing whitespace) and mapped back to the original span, so every byte outside the
 * matched spans stays as it was.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
		replaceAll: edit.replaceAll,
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const hasAll = normalizedEdits.some((edit) => edit.replaceAll === true);
	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		if (edit.replaceAll === true) {
			const matches = findAllEditOccurrences(normalizedContent, edit.oldText);
			if (!matches.length)
				throw getNotFoundError(path, i, normalizedEdits.length, mismatchHint(normalizedContent, edit.oldText));
			for (const matchIndex of matches)
				matchedEdits.push({
					editIndex: i,
					matchIndex,
					matchLength: edit.oldText.length,
					newText: edit.newText,
				});
			continue;
		}
		if (hasAll && !normalizedContent.includes(edit.oldText))
			throw new Error("Unsupported mixed all-occurrence and fuzzy edits; use separate calls");
		const found = findText(normalizedContent, edit.oldText);
		if (!found) {
			throw getNotFoundError(path, i, normalizedEdits.length, mismatchHint(normalizedContent, edit.oldText));
		}
		if (found.occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, found.occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: found.index,
			matchLength: found.matchLength,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const baseContent = normalizedContent;
	const replacements = matchedEdits;
	const newContent = applyReplacements(baseContent, replacements);

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent, replacements };
}
