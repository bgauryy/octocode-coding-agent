/**
 * Extract ANSI escape sequences from a string at the given position.
 */
export function extractAnsiCode(str: string, pos: number): { code: string; length: number } | null {
	const length = ansiCodeLength(str, pos);
	return length > 0 ? { code: str.substring(pos, pos + length), length } : null;
}

const ESC = 0x1b;
/** 8-bit C1 string terminator (ST); only text stripping honors it, see strippableCodeLength. */
const C1_ST = 0x9c;
/** 8-bit C1 introducers (DCS, SOS, CSI, OSC, PM, APC) and the final byte of their 7-bit `ESC` forms. */
const C1_INTRODUCERS = new Map<number, number>([
	[0x90, 0x50],
	[0x98, 0x58],
	[0x9b, 0x5b],
	[0x9d, 0x5d],
	[0x9e, 0x5e],
	[0x9f, 0x5f],
]);
const C1_INTRODUCER_PATTERN = /[\x90\x98\x9b\x9d-\x9f]/;
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
function scanEscape(str: string, pos: number, c1: boolean): number {
	const introducer = C1_INTRODUCERS.get(str.charCodeAt(pos));
	// An 8-bit C1 introducer is one character, so its body starts right after it.
	const next = introducer ?? str.charCodeAt(pos + 1);
	if (Number.isNaN(next)) return INCOMPLETE;
	const bodyStart = introducer === undefined ? pos + 2 : pos + 1;

	// CSI (ECMA-48): ESC [, parameter bytes 0x30-0x3F, intermediate bytes 0x20-0x2F, one final byte 0x40-0x7E.
	// Any other byte before the final byte means this is not a CSI.
	if (next === 0x5b) {
		let j = bodyStart;
		while (j < str.length && isCsiParameter(str.charCodeAt(j))) j++;
		while (j < str.length && isIntermediate(str.charCodeAt(j))) j++;
		if (j >= str.length) return INCOMPLETE;
		return isCsiFinal(str.charCodeAt(j)) ? j + 1 - pos : 0;
	}

	// OSC (ESC ]), APC (ESC _), SOS (ESC X) and PM (ESC ^): ended by BEL or ST (ESC \).
	// OSC is used for hyperlinks and window titles, APC for the cursor marker and application commands.
	if (next === 0x5d || next === 0x5f || next === 0x58 || next === 0x5e) {
		for (let j = bodyStart; j < str.length; j++) {
			const c = str.charCodeAt(j);
			if (c === 0x07 || (c1 && c === C1_ST)) return j + 1 - pos;
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
		for (let j = bodyStart; j < str.length; j++) {
			if (c1 && str.charCodeAt(j) === C1_ST) return j + 1 - pos;
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
	const length = scanEscape(str, pos, false);
	return length > 0 ? length : 0;
}

/**
 * Like ansiCodeLength, for removing sequences from text: an 8-bit C1 introducer (U+009B CSI, U+009D OSC, U+0090 DCS,
 * U+0098 SOS, U+009E PM, U+009F APC) starts a sequence too, and U+009C (ST) ends a string sequence. Width measurement
 * keeps recognizing only `ESC`-introduced sequences, because terminals in UTF-8 mode do not act on C1 characters.
 */
export function strippableCodeLength(str: string, pos: number): number {
	const code = str.charCodeAt(pos);
	if (code !== ESC && !C1_INTRODUCERS.has(code)) return 0;
	const length = scanEscape(str, pos, true);
	return length > 0 ? length : 0;
}

/** Whether the text holds a character that can start a sequence strippableCodeLength removes. */
export function mayHaveStrippableCode(str: string): boolean {
	return str.includes("\x1b") || C1_INTRODUCER_PATTERN.test(str);
}

/** Remove ESC and 8-bit C1 control sequences (CSI, OSC, APC, DCS and others) while preserving visible text. */
export function stripTerminalSequences(str: string): string {
	if (!mayHaveStrippableCode(str)) return str;
	let result = "";
	let i = 0;
	while (i < str.length) {
		const length = strippableCodeLength(str, i);
		if (length > 0) {
			i += length;
			continue;
		}
		result += str[i];
		i++;
	}
	return result;
}

/**
 * Index of the first escape sequence at or after `from` that the text ends inside (a sequence a later chunk could
 * finish, such as `ESC [ 3` or an OSC without its terminator), or -1 when the text ends outside any sequence.
 * Recognizes the 8-bit C1 forms too, as strippableCodeLength does.
 */
export function incompleteAnsiStart(str: string, from = 0): number {
	for (let i = from; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code !== ESC && !C1_INTRODUCERS.has(code)) continue;
		const length = scanEscape(str, i, true);
		if (length === INCOMPLETE) return i;
		if (length > 0) i += length - 1;
	}
	return -1;
}
