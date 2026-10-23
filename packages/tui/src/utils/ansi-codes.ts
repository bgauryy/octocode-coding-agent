/**
 * Extract ANSI escape sequences from a string at the given position.
 */
export function extractAnsiCode(str: string, pos: number): { code: string; length: number } | null {
	const length = ansiCodeLength(str, pos);
	return length > 0 ? { code: str.substring(pos, pos + length), length } : null;
}

/** Length of the ANSI/OSC/APC escape sequence starting at `pos`, or 0 if there is none. */
export function ansiCodeLength(str: string, pos: number): number {
	if (pos >= str.length || str.charCodeAt(pos) !== 0x1b) return 0;

	const next = str[pos + 1];

	// CSI sequence: ESC [ ... m/G/K/H/J
	if (next === "[") {
		for (let j = pos + 2; j < str.length; j++) {
			const c = str.charCodeAt(j);
			// m, G, K, H, J
			if (c === 0x6d || c === 0x47 || c === 0x4b || c === 0x48 || c === 0x4a) return j + 1 - pos;
		}
		return 0;
	}

	// OSC sequence: ESC ] ... BEL or ESC ] ... ST (ESC \)
	// Used for hyperlinks (OSC 8), window titles, etc.
	// APC sequence: ESC _ ... BEL or ESC _ ... ST (ESC \)
	// Used for cursor marker and application-specific commands
	if (next === "]" || next === "_") {
		for (let j = pos + 2; j < str.length; j++) {
			const c = str.charCodeAt(j);
			if (c === 0x07) return j + 1 - pos;
			if (c === 0x1b && str[j + 1] === "\\") return j + 2 - pos;
		}
		return 0;
	}

	return 0;
}
