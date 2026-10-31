/**
 * Extract ANSI escape sequences from a string at the given position.
 */
export function extractAnsiCode(str: string, pos: number): { code: string; length: number } | null {
	const length = ansiCodeLength(str, pos);
	return length > 0 ? { code: str.substring(pos, pos + length), length } : null;
}

const ESC = 0x1b;
/** Scan result: the sequence reached the end of the text before its terminator, but could still be completed. */
const INCOMPLETE = -1;

const isCsiParameter = (c: number): boolean => c >= 0x30 && c <= 0x3f;
const isIntermediate = (c: number): boolean => c >= 0x20 && c <= 0x2f;
const isCsiFinal = (c: number): boolean => c >= 0x40 && c <= 0x7e;
const isEscFinal = (c: number): boolean => c >= 0x30 && c <= 0x7e;

/**
 * The one escape-sequence grammar. Returns the length of the sequence starting at `pos` (an ESC), 0 when none
 * starts there, or INCOMPLETE when the text ends inside a sequence that a later chunk could finish.
 */
function scanEscape(str: string, pos: number): number {
	const next = str.charCodeAt(pos + 1);
	if (Number.isNaN(next)) return INCOMPLETE;

	// CSI (ECMA-48): ESC [, parameter bytes 0x30-0x3F, intermediate bytes 0x20-0x2F, one final byte 0x40-0x7E.
	// Any other byte before the final byte means this is not a CSI.
	if (next === 0x5b) {
		let j = pos + 2;
		while (j < str.length && isCsiParameter(str.charCodeAt(j))) j++;
		while (j < str.length && isIntermediate(str.charCodeAt(j))) j++;
		if (j >= str.length) return INCOMPLETE;
		return isCsiFinal(str.charCodeAt(j)) ? j + 1 - pos : 0;
	}

	// OSC (ESC ]), APC (ESC _), SOS (ESC X) and PM (ESC ^): ended by BEL or ST (ESC \).
	// OSC is used for hyperlinks and window titles, APC for the cursor marker and application commands.
	if (next === 0x5d || next === 0x5f || next === 0x58 || next === 0x5e) {
		for (let j = pos + 2; j < str.length; j++) {
			const c = str.charCodeAt(j);
			if (c === 0x07) return j + 1 - pos;
			if (c === ESC) {
				if (j + 1 >= str.length) return INCOMPLETE;
				if (str.charCodeAt(j + 1) === 0x5c) return j + 2 - pos;
			}
		}
		return INCOMPLETE;
	}

	// DCS (ESC P): ended by ST. tmux passthrough (ESC P tmux; ...) doubles every ESC inside it, so only a lone
	// ESC \ ends the sequence.
	if (next === 0x50) {
		for (let j = pos + 2; j < str.length; j++) {
			if (str.charCodeAt(j) !== ESC) continue;
			if (j + 1 >= str.length) return INCOMPLETE;
			if (str.charCodeAt(j + 1) === ESC) j++;
			else if (str.charCodeAt(j + 1) === 0x5c) return j + 2 - pos;
		}
		return INCOMPLETE;
	}

	// Other escapes (ISO 2022 / ECMA-35): ESC, intermediate bytes 0x20-0x2F, one final byte 0x30-0x7E.
	// Covers RIS (ESC c), save/restore cursor (ESC 7, ESC 8), charset selection (ESC ( 0) and a lone ST (ESC \).
	let j = pos + 1;
	while (j < str.length && isIntermediate(str.charCodeAt(j))) j++;
	if (j >= str.length) return INCOMPLETE;
	return isEscFinal(str.charCodeAt(j)) ? j + 1 - pos : 0;
}

/** Length of the escape sequence (CSI, OSC, APC, SOS, PM, DCS or other ESC sequence) starting at `pos`, or 0 if there is none. */
export function ansiCodeLength(str: string, pos: number): number {
	if (pos >= str.length || str.charCodeAt(pos) !== ESC) return 0;
	const length = scanEscape(str, pos);
	return length > 0 ? length : 0;
}

/**
 * Index of the first escape sequence at or after `from` that the text ends inside (a sequence a later chunk could
 * finish, such as `ESC [ 3` or an OSC without its terminator), or -1 when the text ends outside any sequence.
 */
export function incompleteAnsiStart(str: string, from = 0): number {
	let i = str.indexOf("\x1b", from);
	while (i !== -1) {
		const length = scanEscape(str, i);
		if (length === INCOMPLETE) return i;
		i = str.indexOf("\x1b", i + (length > 0 ? length : 1));
	}
	return -1;
}
