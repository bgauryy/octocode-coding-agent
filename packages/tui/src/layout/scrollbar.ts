import { isImageLine } from "../terminal-image.ts";
import { visibleWidth } from "../utils/width.ts";
import { getGraphemeCellRange, sliceByColumn } from "../utils/columns.ts";
import { getActiveBackgroundAnsi } from "../utils/ansi-tracker.ts";
import { extractAnsiCode } from "../utils/ansi-codes.ts";
import type { LayoutBox, ScrollbarGeometry } from "./types.ts";

/**
 * Rows already cut for a scrollbar cell. A scroll moves the same rows by a line or two, so nearly every row of the
 * next frame was cut in the last one: without this each frame re-segments every visible row, the largest fixed cost of
 * a scroll frame. The key holds everything the result depends on; the map is emptied when it grows past a few screens.
 */
const cutRows = new Map<string, string>();
const CUT_ROWS_LIMIT = 2048;

function replaceScrollbarCell(
	line: string,
	column: number,
	totalWidth: number,
	replacement: string,
	preserveTargetBackground: boolean,
): string {
	if (isImageLine(line)) return line;
	const key = `${column}\0${totalWidth}\0${preserveTargetBackground ? 1 : 0}\0${replacement}\0${line}`;
	const known = cutRows.get(key);
	if (known !== undefined) return known;
	const cut = cutScrollbarCell(line, column, totalWidth, replacement, preserveTargetBackground);
	if (cutRows.size >= CUT_ROWS_LIMIT) cutRows.clear();
	cutRows.set(key, cut);
	return cut;
}

function cutScrollbarCell(
	line: string,
	column: number,
	totalWidth: number,
	replacement: string,
	preserveTargetBackground: boolean,
): string {
	const graphemeRange = getGraphemeCellRange(line, column);
	const start = graphemeRange?.start ?? column;
	const end = graphemeRange?.end ?? column + 1;
	const before = sliceByColumn(line, 0, start, true);
	const target = sliceByColumn(line, start, end - start, true);
	const after = sliceByColumn(line, end, Math.max(0, totalWidth - end), true);

	let targetPrefix = "";
	let targetIndex = 0;
	while (targetIndex < target.length) {
		const ansi = extractAnsiCode(target, targetIndex);
		if (!ansi) break;
		targetPrefix += ansi.code;
		targetIndex += ansi.length;
	}
	const beforePadding = " ".repeat(Math.max(0, start - visibleWidth(before)));
	const cellPaddingBefore = " ".repeat(Math.max(0, column - start));
	const cellPaddingAfter = " ".repeat(Math.max(0, end - column - 1));
	const targetStyle = `\x1b[0m\x1b]8;;\x07${preserveTargetBackground ? getActiveBackgroundAnsi(targetPrefix) : ""}`;
	return `${before}${beforePadding}${targetStyle}${cellPaddingBefore}${replacement}${cellPaddingAfter}${after}`;
}

export function getScrollbarGeometry(box: LayoutBox, includeHiddenAuto = false): ScrollbarGeometry | undefined {
	if (!box.scrollView || box.rect.width <= 0 || box.rect.height <= 0) return undefined;

	const contentHeight = box.children[0]?.rect.height ?? box.scrollContentLines?.length ?? 0;
	const trackHeight = box.rect.height;
	const canRevealHiddenAuto = includeHiddenAuto && box.scrollView.scrollbar === "auto" && contentHeight > trackHeight;
	if (!box.scrollView.isScrollbarVisible && !canRevealHiddenAuto) return undefined;

	const minThumbHeight = Math.min(2, trackHeight);
	const thumbHeight = Math.max(
		minThumbHeight,
		Math.min(trackHeight, Math.round((trackHeight * trackHeight) / contentHeight)),
	);
	const maxScrollTop = Math.max(0, contentHeight - trackHeight);
	const maxThumbTop = trackHeight - thumbHeight;
	const thumbOffset = maxScrollTop === 0 ? 0 : Math.round((box.scrollView.scrollTop / maxScrollTop) * maxThumbTop);
	const column = box.rect.x + box.rect.width - 1;
	if (column < box.clip.x || column >= box.clip.x + box.clip.width) return undefined;

	return {
		column,
		trackTop: box.rect.y,
		trackHeight,
		thumbTop: box.rect.y + thumbOffset,
		thumbHeight,
		maxScrollTop,
	};
}

export function paintScrollbar(box: LayoutBox, screen: string[], totalWidth: number): void {
	const geometry = getScrollbarGeometry(box);
	if (!geometry || !box.scrollView) return;

	for (let offset = 0; offset < geometry.trackHeight; offset++) {
		const row = geometry.trackTop + offset;
		if (row < box.clip.y || row >= box.clip.y + box.clip.height || row < 0 || row >= screen.length) continue;
		const isThumb = row >= geometry.thumbTop && row < geometry.thumbTop + geometry.thumbHeight;
		const replacement = isThumb
			? box.scrollView.scrollbarThumbStyle(box.scrollView.isScrollbarActive ? "█" : "┃")
			: box.scrollView.scrollbarTrackStyle("│");
		screen[row] = replaceScrollbarCell(
			screen[row] ?? "",
			geometry.column,
			totalWidth,
			replacement,
			box.scrollView.scrollbar !== "always",
		);
	}
}
