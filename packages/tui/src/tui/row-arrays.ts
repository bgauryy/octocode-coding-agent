/**
 * Building a frame's row arrays with one allocation each.
 *
 * A long transcript has over a hundred thousand rows, so every array of all of them lands in the engine's large-object
 * space: each one costs fresh memory pages and a full collection to free. A frame that changes only the last rows copies
 * the earlier ones from the last frame's array once, at the final size, and writes the rest over it; appending to a
 * copy instead would copy everything a second time when the array grows.
 */

/**
 * An array of `length` rows whose first `keep` are those of `previous` (`keep` ≤ both lengths); the caller writes every
 * row from `keep` on. Undefined when there is nothing to keep: the caller then builds the array from scratch.
 */
export function arrayWithPrefix(previous: readonly string[], keep: number, length: number): string[] | undefined {
	if (keep <= 0) return undefined;
	if (length <= previous.length) return previous.slice(0, length);
	return previous.concat(Array.from({ length: length - previous.length }, () => ""));
}

/** `compute` of each row, taking the value from `knownValues` for a row equal to the one at the same index in `knownRows`. */
export function mapRowsReusing<T>(
	rows: readonly string[],
	knownRows: readonly string[],
	knownValues: readonly T[],
	compute: (row: string) => T,
): T[] {
	return rows.map((row, index) => (row === knownRows[index] ? knownValues[index] : compute(row)));
}
