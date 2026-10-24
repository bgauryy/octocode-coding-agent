/** Characters per shingle; a hit needs `RUN` consecutive ones (33 characters at the default). */
const SHINGLE = 32;
export const RUN = 2;
const B1 = 0x01000193;
const B2 = 0x5bd1e995;
const POW1 = power(B1, SHINGLE);
const POW2 = power(B2, SHINGLE);

export const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>`)\]}]+/gi;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
/** Secret-like tokens on a flagged line: 16+ word characters, or 12+ holding a letter and a digit (a key id, a token body). */
const TOKEN_PATTERN = /[A-Za-z0-9_-]{12,}/g;

function power(base: number, exponent: number): number {
	let out = 1;
	for (let n = 0; n < exponent; n++) out = Math.imul(out, base);
	return out;
}

export const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

/** One 53-bit key per `SHINGLE`-character window of `text`, in order (two 32-bit rolling hashes combined). */
export function shingles(text: string): number[] {
	const keys: number[] = [];
	let h1 = 0;
	let h2 = 0;
	for (let at = 0; at < text.length; at++) {
		const code = text.charCodeAt(at);
		h1 = (Math.imul(h1, B1) + code) | 0;
		h2 = (Math.imul(h2, B2) + code) | 0;
		if (at >= SHINGLE) {
			const out = text.charCodeAt(at - SHINGLE);
			h1 = (h1 - Math.imul(out, POW1)) | 0;
			h2 = (h2 - Math.imul(out, POW2)) | 0;
		}
		if (at >= SHINGLE - 1) keys.push((h1 >>> 0) * 0x200000 + (h2 >>> 11));
	}
	return keys;
}

/** The key of a whole atom (URL, host, e-mail, secret token); the prefix keeps it apart from any text window. */
const atomKey = (kind: string, value: string): number =>
	shingles(`\u0001${kind}:${value}`.padEnd(SHINGLE, "\u0001")).at(-1)!;

/** Whole URLs, their hosts and e-mail addresses in `text`. */
export function atoms(text: string): number[] {
	const keys: number[] = [];
	for (const match of text.matchAll(URL_PATTERN)) {
		const url = match[0].replace(/[.,;:!?]+$/, "");
		keys.push(atomKey("url", url));
		const host = hostOf(url);
		if (host) keys.push(atomKey("host", host));
	}
	for (const match of text.matchAll(EMAIL_PATTERN)) keys.push(atomKey("email", match[0].toLowerCase()));
	return keys;
}

function hostOf(url: string): string | undefined {
	try {
		return new URL(url).hostname.toLowerCase() || undefined;
	} catch {
		return undefined;
	}
}

export function tokens(text: string): number[] {
	return [...text.matchAll(TOKEN_PATTERN)]
		.map((match) => match[0])
		.filter((token) => token.length >= 16 || (/\d/.test(token) && /[A-Za-z]/.test(token)))
		.map((token) => atomKey("token", token));
}

/** `text` cut to its first `maxBytes` UTF-8 bytes. */
export function capBytes(text: string, maxBytes: number): string {
	if (text.length * 3 <= maxBytes) return text;
	const bytes = Buffer.from(text, "utf8");
	return bytes.length <= maxBytes ? text : bytes.subarray(0, maxBytes).toString("utf8");
}

export function decoded(value: string): string {
	try {
		return decodeURIComponent(value.replace(/\+/g, " "));
	} catch {
		return value;
	}
}
