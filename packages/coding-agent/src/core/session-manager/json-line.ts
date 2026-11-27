/**
 * A session line as JSON every strict reader takes, SQLite's JSON functions included: the database mirror stores each
 * line as written, and `json_extract` over `session_entries.data` must not fail on one of them. `JSON.stringify` writes
 * a lone UTF-16 surrogate (binary or cut tool text) as a `\udXXX` escape, whose meaning RFC 8259 leaves to the reader,
 * and nests as deep as the value does, while SQLite refuses JSON nested 1000 levels or more ("malformed JSON") that
 * JavaScript and Python still parse. A line with either is serialized again from its parsed value: each lone surrogate
 * becomes U+FFFD, and an object or array deeper than `MAX_JSON_DEPTH` levels is stored as its own JSON text (a string).
 */

/** The deepest object or array a line nests: far below SQLite's limit, so a reader may wrap a line and still parse it. */
const MAX_JSON_DEPTH = 256;

/**
 * A `\udXXX` escape of a surrogate: `JSON.stringify` escapes only lone ones. Text holding a literal backslash before
 * `ud800` matches too, which costs a second pass and changes nothing.
 */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/** The serialized `value`, strictly valid and at most `MAX_JSON_DEPTH` levels deep. */
export function strictJsonLine(value: unknown): string {
	return strictJsonText(JSON.stringify(value));
}

/** `line` (the `JSON.stringify` of a value) as `strictJsonLine` writes it: the same text unless it needs the repair. */
export function strictJsonText(line: string): string {
	if (!SURROGATE_ESCAPE.test(line) && !deeperThan(line, MAX_JSON_DEPTH)) return line;
	return JSON.stringify(strictValue(JSON.parse(line), 1));
}

/** Whether `line` (JSON text) nests objects and arrays more than `max` levels; strings are skipped whole. */
function deeperThan(line: string, max: number): boolean {
	// Each level opens and closes once.
	if (line.length <= max * 2) return false;
	let depth = 0;
	for (let at = 0; at < line.length; at++) {
		const code = line.charCodeAt(at);
		if (code === QUOTE) {
			at = stringEnd(line, at);
			if (at < 0) return false;
		} else if (code === 0x7b || code === 0x5b) {
			if (++depth > max) return true;
		} else if (code === 0x7d || code === 0x5d) depth--;
	}
	return false;
}

/** The index of the quote that closes the string opened at `open`, or -1 when none does. */
function stringEnd(line: string, open: number): number {
	for (let at = line.indexOf('"', open + 1); at >= 0; at = line.indexOf('"', at + 1)) {
		let slashes = 0;
		for (let back = at - 1; line.charCodeAt(back) === BACKSLASH; back--) slashes++;
		if (slashes % 2 === 0) return at;
	}
	return -1;
}

/** `value` (parsed JSON at nesting level `depth`) with well-formed strings and keys, cut to `MAX_JSON_DEPTH` levels. */
function strictValue(value: unknown, depth: number): unknown {
	if (typeof value === "string") return value.toWellFormed();
	if (value === null || typeof value !== "object") return value;
	if (depth > MAX_JSON_DEPTH) return JSON.stringify(value);
	if (Array.isArray(value)) return value.map((item) => strictValue(item, depth + 1));
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key.toWellFormed(), strictValue(item, depth + 1)]),
	);
}
