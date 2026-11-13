import { deleteKittyImage, isImageLine } from "../terminal-image.ts";
import { visibleWidth } from "../utils/width.ts";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";

interface KittyImageHeader {
	ids: number[];
	rows: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return undefined;
	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return undefined;

	const ids: number[] = [];
	let rows = 1;
	for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
		const [key, value] = param.split("=", 2);
		if (value === undefined) continue;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
		if (key === "i") ids.push(numberValue);
		else if (key === "r") rows = numberValue;
	}
	return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
	return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
	return parseKittyImageHeader(line)?.rows ?? 1;
}

/** Rows that hold a Kitty image, in ascending order, with the image ids each one names. */
export type KittyImageRows = ReadonlyMap<number, number[]>;

function scanKittyImageRows(lines: readonly string[], from: number, to: number, into: Map<number, number[]>): void {
	for (let row = from; row < to; row++) {
		const ids = extractKittyImageIds(lines[row] ?? "");
		if (ids.length > 0) into.set(row, ids);
	}
}

export function findKittyImageRows(lines: readonly string[]): KittyImageRows {
	const rows = new Map<number, number[]>();
	scanKittyImageRows(lines, 0, lines.length, rows);
	return rows;
}

/**
 * The Kitty image rows of `lines`, carried over from rows of `knownLines` that are equal at the same index, so a frame
 * scans only the rows that changed and not the whole transcript.
 */
export function carryKittyImageRows(
	knownLines: readonly string[],
	knownRows: KittyImageRows,
	lines: readonly string[],
	unchanged = 0,
): KittyImageRows {
	const shared = Math.min(knownLines.length, lines.length);
	// The caller vouches that the first `unchanged` rows are the same strings.
	let first = Math.max(0, Math.min(unchanged, shared));
	while (first < shared && knownLines[first] === lines[first]) first++;
	let last = shared - 1;
	while (last >= first && knownLines[last] === lines[last]) last--;
	const rows = new Map<number, number[]>();
	const carry = (from: number, to: number): void => {
		for (const [row, ids] of knownRows) if (row >= from && row < to) rows.set(row, ids);
	};
	carry(0, first);
	scanKittyImageRows(lines, first, last + 1, rows);
	carry(last + 1, shared);
	scanKittyImageRows(lines, shared, lines.length, rows);
	return rows;
}

/**
 * Image rows of the last two line arrays asked for: a frame asks for the previous frame's lines and its own, and its
 * own become the next frame's previous lines.
 */
export class KittyImageRowCache {
	private entries: Array<{ lines: readonly string[]; rows: KittyImageRows }> = [];

	/** `same`: `lines` shares its first `unchanged` rows (same strings) with the `from` lines. */
	of(lines: readonly string[], same?: { from: readonly string[]; unchanged: number }): KittyImageRows {
		const hit = this.entries.find((entry) => entry.lines === lines);
		if (hit) return hit.rows;
		const known = this.entries.at(-1);
		const unchanged = known && same?.from === known.lines ? same.unchanged : 0;
		const rows = known ? carryKittyImageRows(known.lines, known.rows, lines, unchanged) : findKittyImageRows(lines);
		this.entries = [...this.entries.slice(-1), { lines, rows }];
		return rows;
	}
}

export function collectKittyImageIds(lines: string[], rows: KittyImageRows = findKittyImageRows(lines)): Set<number> {
	const ids = new Set<number>();
	for (const rowIds of rows.values()) {
		for (const id of rowIds) {
			ids.add(id);
		}
	}
	return ids;
}

export function deleteKittyImages(ids: Iterable<number>): string {
	let buffer = "";
	for (const id of ids) {
		buffer += deleteKittyImage(id);
	}
	return buffer;
}

export function getKittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
	const rows = extractKittyImageRows(lines[index] ?? "");
	if (rows <= 1) return 1;

	const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
	let reservedRows = 1;
	while (reservedRows < maxRows) {
		const line = lines[index + reservedRows] ?? "";
		if (isImageLine(line) || visibleWidth(line) > 0) break;
		reservedRows++;
	}
	return reservedRows;
}

export function expandChangedRangeForKittyImages(
	previousLines: string[],
	firstChanged: number,
	lastChanged: number,
	newLines: string[],
	imageRows: { previous: KittyImageRows; next: KittyImageRows } = {
		previous: findKittyImageRows(previousLines),
		next: findKittyImageRows(newLines),
	},
): { firstChanged: number; lastChanged: number } {
	let expandedFirstChanged = firstChanged;
	let expandedLastChanged = lastChanged;
	const expandForLines = (lines: string[], rows: KittyImageRows): void => {
		for (const i of rows.keys()) {
			const blockEnd = i + getKittyImageReservedRows(lines, i) - 1;
			if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
				expandedFirstChanged = Math.min(expandedFirstChanged, i);
				expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
			}
		}
	};

	expandForLines(previousLines, imageRows.previous);
	expandForLines(newLines, imageRows.next);
	return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
}

export function deleteChangedKittyImages(
	previousLines: string[],
	firstChanged: number,
	lastChanged: number,
	previousRows: KittyImageRows = findKittyImageRows(previousLines),
): string {
	if (firstChanged < 0 || lastChanged < firstChanged) return "";

	const ids = new Set<number>();
	const maxLine = Math.min(lastChanged, previousLines.length - 1);
	for (const [row, rowIds] of previousRows) {
		if (row < firstChanged || row > maxLine) continue;
		for (const id of rowIds) {
			ids.add(id);
		}
	}

	return deleteKittyImages(ids);
}
