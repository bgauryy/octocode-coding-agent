import type { AltScreenSearchMatch } from "../alt-screen-search.ts";
import type { ScrollView } from "../components/scroll-view.ts";
import { getScrollbarGeometry, getScrollViewBox, type LayoutFrame } from "../layout.ts";
import { isImageLine } from "../terminal-image.ts";
import { extractAnsiCode, sliceByColumn, visibleWidth } from "../utils.ts";
import type { ActiveSearch, SearchHighlightRange } from "./types.ts";

/** Wrap the visible text of `text` in `style`, keeping its ANSI codes outside the styled runs. */
export function applySearchTextHighlight(text: string, style: (text: string) => string): string {
	let result = "";
	let plainStart = 0;
	let index = 0;
	while (index < text.length) {
		const ansi = extractAnsiCode(text, index);
		if (!ansi) {
			index += 1;
			continue;
		}
		if (index > plainStart) result += style(text.slice(plainStart, index));
		result += ansi.code;
		index += ansi.length;
		plainStart = index;
	}
	if (plainStart < text.length) result += style(text.slice(plainStart));
	return result;
}

/** Highlight the visible matches of the active search in the primary scroll view. */
export function applySearchHighlights(
	screen: string[],
	layout: LayoutFrame,
	search: ActiveSearch | undefined,
	fallbackScrollView: ScrollView,
	terminalColumns: number,
	highlight: (text: string, current: boolean) => string,
): string[] {
	if (!search || search.selectedIndex < 0 || search.matches.length === 0) return screen;
	const scrollView = layout.primaryScrollView ?? fallbackScrollView;
	const box = getScrollViewBox(layout, scrollView);
	if (!box) return screen;

	const rangesByRow = new Map<number, SearchHighlightRange[]>();
	const scrollbarColumn = getScrollbarGeometry(box)?.column;
	const minRow = Math.max(0, box.rect.y, box.clip.y);
	const maxRow = Math.min(screen.length, box.rect.y + box.rect.height, box.clip.y + box.clip.height);
	const minColumn = Math.max(0, box.rect.x, box.clip.x);
	const maxColumn = Math.min(
		terminalColumns,
		box.rect.x + box.rect.width,
		box.clip.x + box.clip.width,
		scrollbarColumn ?? Number.POSITIVE_INFINITY,
	);
	const minContentRow = scrollView.scrollTop + minRow - box.rect.y;
	const maxContentRow = scrollView.scrollTop + maxRow - box.rect.y - 1;
	let low = 0;
	let high = search.matches.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		const match = search.matches[middle];
		const lastRow = match.segments[match.segments.length - 1]?.row ?? -1;
		if (lastRow < minContentRow) low = middle + 1;
		else high = middle;
	}
	for (let matchIndex = low; matchIndex < search.matches.length; matchIndex++) {
		const match = search.matches[matchIndex];
		if ((match.segments[0]?.row ?? 0) > maxContentRow) break;
		for (const segment of match.segments) {
			const row = box.rect.y + segment.row - scrollView.scrollTop;
			if (row < minRow || row >= maxRow) continue;
			const startCol = Math.max(minColumn, box.rect.x + segment.startCol);
			const endCol = Math.min(maxColumn, box.rect.x + segment.endCol);
			if (endCol <= startCol) continue;
			const ranges = rangesByRow.get(row) ?? [];
			ranges.push({ startCol, endCol, current: matchIndex === search.selectedIndex });
			rangesByRow.set(row, ranges);
		}
	}

	const result = [...screen];
	for (const [row, ranges] of rangesByRow) {
		let line = result[row] ?? "";
		if (isImageLine(line)) continue;
		const lineWidth = visibleWidth(line);
		for (const range of ranges.sort((a, b) => b.startCol - a.startCol)) {
			const startCol = Math.min(range.startCol, lineWidth);
			const endCol = Math.min(range.endCol, lineWidth);
			if (endCol <= startCol) continue;
			const before = sliceByColumn(line, 0, startCol, true);
			const highlighted = sliceByColumn(line, startCol, endCol - startCol, true);
			const after = sliceByColumn(line, endCol, Math.max(0, lineWidth - endCol), true);
			line = `${before}${highlight(highlighted, range.current)}${after}`;
		}
		result[row] = line;
	}
	return result;
}

/** Pick the match to select after a search ran, from the search's selection mode. */
export function pickSearchSelection(search: ActiveSearch, matches: AltScreenSearchMatch[], exactIndex: number): number {
	let selectedIndex = -1;
	if (matches.length > 0) {
		if (search.selectionMode === "query") {
			let low = 0;
			let high = matches.length;
			while (low < high) {
				const middle = low + Math.floor((high - low) / 2);
				if ((matches[middle].segments[0]?.row ?? 0) < search.anchorRow) low = middle + 1;
				else high = middle;
			}
			selectedIndex = low < matches.length ? low : 0;
		} else if (search.selectionMode === "next") {
			const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
			selectedIndex = baseIndex < 0 ? 0 : (baseIndex + 1) % matches.length;
		} else if (search.selectionMode === "previous") {
			const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
			selectedIndex = baseIndex < 0 ? matches.length - 1 : (baseIndex - 1 + matches.length) % matches.length;
		} else {
			selectedIndex = exactIndex >= 0 ? exactIndex : Math.min(Math.max(0, search.selectedIndex), matches.length - 1);
		}
	}
	return selectedIndex;
}
