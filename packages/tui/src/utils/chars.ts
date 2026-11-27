export const cjkBreakRegex =
	/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

// CJK letters remain part of words and paths; only punctuation can separate prose from completions.
const cjkPunctuationRegex = new RegExp(
	`(?:(?=\\p{Punctuation})${cjkBreakRegex.source}|[，．：；！？（）［］｛｝“”‘’…—])`,
	"u",
);
export const autocompleteSeparatorRegex = new RegExp(`(?:\\s|${cjkPunctuationRegex.source})`, "u");
export const autocompleteBoundaryRegex = new RegExp(`(?:^|${autocompleteSeparatorRegex.source})`, "u");

export const PUNCTUATION_REGEX = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;

// C0 controls, DEL and C1 controls: code points a terminal may read as the start of a control sequence.
const CONTROL_CHARACTER_REGEX = /[\x00-\x1f\x7f-\x9f]/;
const CONTROL_CHARACTERS_REGEX = /[\x00-\x1f\x7f-\x9f]/g;

/** Whether text holds a C0, DEL or C1 control character, so writing it to the terminal could start an escape sequence. */
export function hasControlCharacter(text: string): boolean {
	return CONTROL_CHARACTER_REGEX.test(text);
}

/** Remove C0, DEL and C1 control characters. */
export function stripControlCharacters(text: string): string {
	return text.replace(CONTROL_CHARACTERS_REGEX, "");
}

/**
 * Check if a character is whitespace.
 */
export function isWhitespaceChar(char: string): boolean {
	return /\s/.test(char);
}
