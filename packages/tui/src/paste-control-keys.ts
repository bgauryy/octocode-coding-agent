/**
 * tmux re-encodes control bytes inside a bracketed paste as extended keys, in the format its `extended-keys-format`
 * option selects: `ESC [ <codepoint> ; 5 u` (csi-u) or xterm's `ESC [ 27 ; 5 ; <codepoint> ~` (the default). Both mean
 * Ctrl+<key>. Left alone, a paste sanitizer strips the ESC and leaks the printable tail (`[27;5;106~`) into the text.
 */
const EXTENDED_CONTROL = /\x1b\[(?:27;5;(\d+)~|(\d+);5u)/g;

/** The control byte for Ctrl+<codepoint>, or undefined when the codepoint has none. */
function controlByte(codepoint: number): string | undefined {
	if (codepoint >= 97 && codepoint <= 122) return String.fromCharCode(codepoint - 96);
	if (codepoint >= 64 && codepoint <= 95) return String.fromCharCode(codepoint - 64);
	return undefined;
}

/** Replaces extended-key Ctrl sequences (both formats) in pasted text with their literal control bytes. */
export function decodePastedControlKeys(text: string): string {
	if (!text.includes("\x1b[")) return text;
	return text.replace(EXTENDED_CONTROL, (match, xterm?: string, csiU?: string) => {
		return controlByte(Number(xterm ?? csiU)) ?? match;
	});
}
