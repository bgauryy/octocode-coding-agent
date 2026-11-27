import { ROWCOLUMN_DIACRITICS } from "./kitty-diacritics.ts";

/** Kitty Unicode placeholder character (U+10EEEE). */
export const KITTY_PLACEHOLDER = "\u{10eeee}";

/** Largest row or column count one image can address with the diacritic table. */
const KITTY_PLACEHOLDER_MAX_CELLS = ROWCOLUMN_DIACRITICS.length;

/** Whether a `columns` x `rows` placeholder grid fits the diacritic table. */
export function kittyPlaceholdersFit(columns: number, rows: number): boolean {
	return columns >= 1 && rows >= 1 && columns <= KITTY_PLACEHOLDER_MAX_CELLS && rows <= KITTY_PLACEHOLDER_MAX_CELLS;
}

function diacritic(index: number): string {
	const codePoint = ROWCOLUMN_DIACRITICS[index];
	return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

/**
 * One placeholder row. The low 24 bits of the image id travel in the foreground colour and the high byte, when set,
 * in a third diacritic. Every cell names its own row and column, so a sliced row still maps to the right region.
 */
export function kittyPlaceholderRow(imageId: number, row: number, columns: number): string {
	const red = (imageId >>> 16) & 0xff;
	const green = (imageId >>> 8) & 0xff;
	const blue = imageId & 0xff;
	const high = imageId >>> 24;
	const rowMark = diacritic(row);
	const idMark = high > 0 ? diacritic(high) : "";
	let cells = "";
	for (let column = 0; column < columns; column++) {
		cells += KITTY_PLACEHOLDER + rowMark + diacritic(column) + idMark;
	}
	return `\x1b[38;2;${red};${green};${blue}m${cells}\x1b[39m`;
}

/** Exactly `rows` placeholder rows. The transmit sequence is prepended to the first by the caller. */
export function kittyPlaceholderRows(imageId: number, columns: number, rows: number): string[] {
	return Array.from({ length: rows }, (_, row) => kittyPlaceholderRow(imageId, row, columns));
}

// A placeholder row starts with the cell run, after optional styling or indentation.
const PLACEHOLDER_LINE_PATTERN = /^(?:\x1b\[[0-9;:]*m| )*\u{10eeee}/u;

/** Whether a line starts with placeholder cells. */
export function isKittyPlaceholderLine(line: string): boolean {
	return PLACEHOLDER_LINE_PATTERN.test(line);
}
