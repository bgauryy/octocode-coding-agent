/**
 * Model ids and names from a vendor model list or a remote catalog are network text that terminals and UIs draw. An id
 * is a key sent back to the vendor, so one holding a control is rejected, never rewritten; a name only labels a model,
 * so its control sequences are stripped. Vendors use slashes, colons, dots, `@`, underscores and spaces in ids; those
 * stay. This is the package's own small check: the host's terminal sanitizer lives in a package `ai` must not import.
 */

/**
 * C0 and C1 controls (tab and line breaks included), DEL, the soft hyphen, the Arabic letter mark, the Mongolian vowel
 * separator, zero-width and bidi formatting characters, line and paragraph separators, word joiners and invisible
 * operators, the BOM and Unicode tags.
 */
const CONTROL_CHARACTER =
	/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\u{e0000}-\u{e007f}]/u;
const CONTROL_CHARACTERS = new RegExp(CONTROL_CHARACTER.source, "gu");
/** OSC, DCS, SOS, PM and APC strings (an unterminated one ends at its line), then CSI, then any other ESC sequence. */
const TERMINAL_SEQUENCE =
	/(?:\u001b[\]P_X^]|[\u0090\u0098\u009d\u009e\u009f])[^\n]*?(?:\u0007|\u001b\\|\u009c|(?=\n)|$)|(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]/gu;

/** Whether `text` holds a character that can steer a terminal or hide or reorder text; such a model id is rejected. */
export function hasControlCharacters(text: string): boolean {
	return CONTROL_CHARACTER.test(text);
}

/** A one-line model label: terminal sequences and control characters removed, line breaks and tabs folded to spaces. */
export function modelLabel(text: string): string {
	if (!CONTROL_CHARACTER.test(text)) return text.trim();
	return text
		.replace(TERMINAL_SEQUENCE, "")
		.replace(/[\t\n\v\f\r\u2028\u2029]+/gu, " ")
		.replace(CONTROL_CHARACTERS, "")
		.replace(/ {2,}/g, " ")
		.trim();
}
