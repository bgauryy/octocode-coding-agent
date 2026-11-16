/**
 * The length of a value's JSON text, measured once. The transcript compares display values with size limits at several
 * steps (a tool's result data, then the tool's whole state, then every delta of a streaming message); a value built for
 * display is never changed afterwards, so its length is kept with the object and each step adds up the lengths of the
 * members it holds instead of serializing them again.
 */

const measured = new WeakMap<object, number>();

/** A long string measured last: a tool's text is measured with its result data and again with its state. */
const TEXT_CHARS = 1024;
let lastText: { text: string; length: number } | undefined;

/** Records that `value` serializes to `length` characters (its serializer already produced the text). */
export function rememberJsonLength<T>(value: T, length: number): T {
	if (typeof value === "object" && value !== null) measured.set(value, length);
	return value;
}

/**
 * `JSON.stringify(value).length`, or undefined when the value serializes to nothing (undefined, a function, a symbol).
 * An object is serialized the first time only: do not ask for one that is changed in place afterwards.
 */
export function jsonLength(value: unknown): number | undefined {
	if (typeof value === "string") {
		if (value.length < TEXT_CHARS) return JSON.stringify(value).length;
		if (lastText?.text !== value) lastText = { text: value, length: JSON.stringify(value).length };
		return lastText.length;
	}
	if (typeof value !== "object" || value === null) return JSON.stringify(value)?.length;
	let length = measured.get(value);
	if (length === undefined) {
		length = JSON.stringify(value)?.length;
		if (length !== undefined) measured.set(value, length);
	}
	return length;
}

/**
 * `JSON.stringify(record).length` for a plain object, from the lengths of its members: `known` gives the length of a
 * member the caller already measured, and every other member is measured by `jsonLength`. The record itself is not
 * remembered, so it may change afterwards.
 */
export function recordJsonLength(record: object, known: Readonly<Record<string, number>> = {}): number {
	let length = 2;
	let members = 0;
	for (const [key, value] of Object.entries(record)) {
		const size = Object.hasOwn(known, key) ? known[key] : jsonLength(value);
		if (size === undefined) continue;
		length += JSON.stringify(key).length + 1 + size;
		members++;
	}
	return length + Math.max(0, members - 1);
}

/** `JSON.stringify(items).length` for an array, each item measured by `jsonLength`. */
export function listJsonLength(items: readonly unknown[]): number {
	let length = 2 + Math.max(0, items.length - 1);
	for (const item of items) length += jsonLength(item) ?? 4;
	return length;
}
