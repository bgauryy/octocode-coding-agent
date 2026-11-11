import { isImageLine } from "../terminal-image.ts";
import { trimTrailingBlanks } from "../tui/trailing-blanks.ts";

/** A block of rows the terminal can scroll in place instead of the frame rewriting them. */
export interface ScrollShift {
	/** Output that scrolls the region (resets attributes first, then restores the full-screen region). */
	sequence: string;
	/** What the screen holds after the sequence runs: the rows the frame is compared against. */
	basis: string[];
}

const MIN_SAVED_ROWS = 3;

/** One screen's last planned rows and their trimmed forms: most rows of its next frame's two screens are these same rows. */
export class TrimmedRowsMemo {
	rows: readonly string[] = [];
	trimmed: readonly string[] = [];
}

/** `trimTrailingBlanks` of each row, reused for a row equal to the one at the same index in `knownRows`. */
function trimRows(rows: readonly string[], knownRows: readonly string[], knownTrimmed: readonly string[]): string[] {
	return rows.map((row, index) => (row === knownRows[index] ? knownTrimmed[index] : trimTrailingBlanks(row)));
}

/**
 * Find the row shift that lets the terminal scroll a region of the previous screen into place, so only
 * the rows the shift does not explain are rewritten. Rows compare by what they paint after an erase.
 * Returns undefined when it would not save rows or when images are involved (their placements do not
 * scroll with text). `memo` only saves trimming work; each screen passes its own.
 */
export function planScrollShift(
	screenRows: readonly string[],
	previousRows: readonly string[],
	memo = new TrimmedRowsMemo(),
): ScrollShift | undefined {
	const height = screenRows.length;
	if (height < 6 || previousRows.length !== height) return undefined;
	if (screenRows.some(isImageLine) || previousRows.some(isImageLine)) return undefined;
	const previous = trimRows(previousRows, memo.rows, memo.trimmed);
	const screen = trimRows(screenRows, previousRows, previous);
	memo.rows = screenRows.slice();
	memo.trimmed = screen;
	let baseline = 0;
	for (let row = 0; row < height; row++) if (screen[row] !== previous[row]) baseline++;
	if (baseline < MIN_SAVED_ROWS + 1) return undefined;

	let best: { shift: number; top: number; bottom: number; cost: number } | undefined;
	for (let distance = 1; distance < height; distance++) {
		for (const shift of [distance, -distance]) {
			let first = -1;
			let last = -1;
			let matches = 0;
			for (let row = 0; row < height; row++) {
				const source = row + shift;
				if (source < 0 || source >= height) continue;
				const line = screen[row];
				if (line === previous[row] || line === "" || line !== previous[source]) continue;
				if (first < 0) first = row;
				last = row;
				matches++;
			}
			if (matches < MIN_SAVED_ROWS) continue;
			const top = shift > 0 ? first : first + shift;
			const bottom = shift > 0 ? last + shift : last;
			let cost = 0;
			for (let row = 0; row < height; row++) {
				const inRegion = row >= top && row <= bottom;
				const source = row + shift;
				const shown = inRegion ? (source >= top && source <= bottom ? previous[source] : "") : previous[row];
				if (screen[row] !== shown) cost++;
			}
			if (!best || cost < best.cost) best = { shift, top, bottom, cost };
		}
	}
	if (!best || baseline - best.cost < MIN_SAVED_ROWS) return undefined;
	const { shift, top, bottom } = best;
	const basis = previousRows.slice();
	for (let row = top; row <= bottom; row++) {
		const source = row + shift;
		basis[row] = source >= top && source <= bottom ? (previousRows[source] ?? "") : "";
	}
	const scroll = shift > 0 ? `\x1b[${shift}S` : `\x1b[${-shift}T`;
	return { sequence: `\x1b[0m\x1b[${top + 1};${bottom + 1}r${scroll}\x1b[r`, basis };
}
