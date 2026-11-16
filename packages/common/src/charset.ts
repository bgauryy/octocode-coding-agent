import { TextDecoder } from "node:util";

/**
 * Text in the body's charset: a byte-order mark, else Content-Type's charset, else (HTML) a `<meta>` charset in the
 * first bytes, else UTF-8; an unknown label falls back to UTF-8. A cut body ends at the last whole character.
 */
export function decodeBody(bytes: Uint8Array, contentType: string, cut = false): string {
	const label =
		bomCharset(bytes) ??
		charsetParameter(contentType) ??
		(contentType.includes("html") ? metaCharset(bytes) : undefined);
	let decoder: TextDecoder;
	try {
		decoder = new TextDecoder(label ?? "utf-8");
	} catch {
		decoder = new TextDecoder("utf-8");
	}
	// Streaming keeps an incomplete trailing sequence back instead of turning it into U+FFFD.
	return decoder.decode(bytes, { stream: cut });
}

function bomCharset(bytes: Uint8Array): string | undefined {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
	return undefined;
}

function charsetParameter(value: string): string | undefined {
	return /;\s*charset\s*=\s*["']?([^"';\s]+)/i.exec(value)?.[1];
}

/** Bytes an HTML charset declaration must appear in (the HTML spec's prescan window). */
const META_PRESCAN_BYTES = 1024;

/** `<meta charset=…>` or `<meta http-equiv=content-type content="…; charset=…">` early in the document. */
function metaCharset(bytes: Uint8Array): string | undefined {
	const head = Buffer.from(bytes.subarray(0, META_PRESCAN_BYTES)).toString("latin1");
	for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
		const direct = /\bcharset\s*=\s*["']?([^"'\s/>;]+)/i.exec(tag)?.[1];
		if (direct) return direct;
	}
	return undefined;
}
