/** Split a leading UTF-8 byte order mark from decoded text. */
export function splitBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/** Remove a leading UTF-8 byte order mark from decoded text. */
export function stripBom(content: string): string {
	return splitBom(content).text;
}

/**
 * The one text cut: the head (or, with `tail`, the end) of `text` within `max` UTF-8 bytes, or UTF-16 code units with
 * `chars`. A character is never cut in half: neither a multi-byte UTF-8 sequence nor a surrogate pair.
 */
export function cutText(
	text: string,
	max: number,
	{ chars = false, tail = false }: { chars?: boolean; tail?: boolean } = {},
): string {
	const limit = Math.max(0, Math.floor(max));
	if (chars) {
		if (text.length <= limit) return text;
		if (tail) {
			let start = text.length - limit;
			if (isLowSurrogate(text.charCodeAt(start))) start++;
			return text.slice(start);
		}
		let end = limit;
		if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end--;
		return text.slice(0, end);
	}
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= limit) return text;
	// UTF-8 continuation bytes are 10xxxxxx: a cut moves off them to the nearest character boundary inside the budget.
	const continuation = (index: number) => (bytes[index] & 0xc0) === 0x80;
	if (tail) {
		let start = bytes.length - limit;
		while (start < bytes.length && continuation(start)) start++;
		return bytes.subarray(start).toString("utf8");
	}
	let end = limit;
	while (end > 0 && continuation(end)) end--;
	return bytes.subarray(0, end).toString("utf8");
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

const SOURCE_HEADER_LINE = /^\[src [^\n]*\n/;

/** `text` without the leading source header line the event loop writes: a row shows the message, the model reads the header. */
export function withoutSourceHeader(text: string): string {
	return text.replace(SOURCE_HEADER_LINE, "");
}
