/**
 * Linear-time strict strikethrough matching. It gives the same match as
 * `/^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/` applied to `source.slice(offset)`,
 * which is quadratic over a run of `~~` openers without a closer because each opener rescans to the end.
 *
 * The regex reads content in units: a backslash and the next character (`\\.`, never a line
 * terminator), or one character that is not a backslash. Units therefore split the text the same way
 * from any opener: a position starts a unit when an even number of backslashes precedes it, and the
 * `~~` opener ends any backslash run. So which `~~` can close, and where content cannot continue (a
 * backslash before a line terminator or the end), are facts of the whole source. One sweep indexes
 * them and each opener looks up its first closer.
 */

export interface StrikethroughIndex {
	/** Positions j where `~~` closes: j starts a unit, the unit before j may end content, and no `~` follows the pair. */
	readonly closers: readonly number[];
	/** Positions of a unit-starting backslash that no unit can consume: content cannot extend past them. */
	readonly blocks: readonly number[];
}

const BACKSLASH = 0x5c;
const TILDE = 0x7e;
const WHITESPACE = /\s/;

function isLineTerminator(code: number): boolean {
	return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;
}

/** A character the regex's `[^\s~\\]` accepts as the last content unit. */
function canEndContent(source: string, index: number): boolean {
	const char = source[index];
	return char !== undefined && char !== "~" && char !== "\\" && !WHITESPACE.test(char);
}

export function indexStrikethrough(source: string): StrikethroughIndex {
	const closers: number[] = [];
	const blocks: number[] = [];
	// Backslashes immediately before the current position, and before the previous one.
	let run = 0;
	let previousRun = 0;
	for (let index = 0; index < source.length; index++) {
		const code = source.charCodeAt(index);
		if (run % 2 === 1 && isLineTerminator(code)) blocks.push(index - 1);
		if (
			run % 2 === 0 &&
			code === TILDE &&
			source.charCodeAt(index + 1) === TILDE &&
			source.charCodeAt(index + 2) !== TILDE &&
			// The unit before the pair: an escaped backslash, an escaped character, or one plain character.
			(run > 0 || previousRun % 2 === 1 || canEndContent(source, index - 1))
		) {
			closers.push(index);
		}
		previousRun = run;
		run = code === BACKSLASH ? run + 1 : 0;
	}
	if (run % 2 === 1) blocks.push(source.length - 1);
	return { closers, blocks };
}

/** The first value at or after `from` in an ascending list. */
function firstAtOrAfter(values: readonly number[], from: number): number | undefined {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (values[middle] < from) low = middle + 1;
		else high = middle;
	}
	return values[low];
}

/** Match a strict `~~text~~` at `offset` of the indexed source. */
export function matchStrikethrough(
	source: string,
	index: StrikethroughIndex,
	offset: number,
): { raw: string; text: string } | undefined {
	if (source.charCodeAt(offset) !== TILDE || source.charCodeAt(offset + 1) !== TILDE) return undefined;
	if (!canEndContent(source, offset + 2) && source.charCodeAt(offset + 2) !== BACKSLASH) return undefined;
	const closer = firstAtOrAfter(index.closers, offset + 3);
	if (closer === undefined) return undefined;
	const block = firstAtOrAfter(index.blocks, offset + 2);
	if (block !== undefined && block < closer) return undefined;
	return { raw: source.slice(offset, closer + 2), text: source.slice(offset + 2, closer) };
}
