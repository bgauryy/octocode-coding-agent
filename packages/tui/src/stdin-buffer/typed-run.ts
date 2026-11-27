/** Whether code point `code` is a typed printable character: not a C0 control, DEL or C1 control. */
export function isTypedCodePoint(code: number): boolean {
	return code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f);
}

/** Whether `text` is at least `min` code points (default 2), all typed printable characters. */
export function isTypedRun(text: string, min = 2): boolean {
	let count = 0;
	for (const char of text) {
		if (!isTypedCodePoint(char.codePointAt(0)!)) return false;
		count++;
	}
	return count >= min;
}
