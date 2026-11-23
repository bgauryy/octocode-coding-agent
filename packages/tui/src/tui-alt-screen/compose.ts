import type { ScrollView } from "../components/scroll-view.ts";
import type { LayoutFrame } from "../layout/types.ts";
import { getScrollbarGeometry } from "../layout/scrollbar.ts";
import { getScrollViewBox } from "../layout.ts";
import { isImageLine } from "../terminal-image.ts";
import { compositeTuiLine } from "../tui/composite.ts";
import { visibleWidth } from "../utils/width.ts";
import { truncateToWidth } from "../utils/truncate.ts";
import { stripTerminalSequences } from "../utils/ansi-codes.ts";
import { sliceByColumn } from "../utils/columns.ts";
import type { ScrollToEndIndicatorRect } from "./types.ts";

/**
 * Center the jump-to-end label on the last row of a follow-end scroll view that is scrolled away
 * from its end. Returns the clickable rectangle when the label was drawn. Text that ends at least one cell before
 * the label stays beside it; text the label would cut mid-word is blanked across the view, so no fragment shows.
 */
export function compositeScrollToEndIndicator(
	screen: string[],
	layout: LayoutFrame,
	width: number,
	implicitScrollView: ScrollView,
	scrollToEndIndicator: ((rowsBelow: number, percent: number) => string) | undefined,
): { screen: string[]; rect?: ScrollToEndIndicatorRect } {
	const scrollView = layout.primaryScrollView ?? implicitScrollView;
	if (!scrollToEndIndicator || !scrollView.followEnd || scrollView.isFollowingEnd) return { screen };
	const box = getScrollViewBox(layout, scrollView);
	const clip = box?.clip;
	if (!clip || clip.width <= 0 || clip.height <= 0) return { screen };
	const row = clip.y + clip.height - 1;
	if (row >= screen.length || isImageLine(screen[row] ?? "")) return { screen };
	const scrollbarColumn = box ? getScrollbarGeometry(box)?.column : undefined;
	const rowsBelow = Math.max(
		0,
		(box?.scrollContentHeight ?? box?.scrollContentLines?.length ?? 0) -
			scrollView.scrollTop -
			scrollView.viewportHeight,
	);
	const contentHeight = box?.scrollContentHeight ?? box?.scrollContentLines?.length ?? 0;
	const scrollable = Math.max(1, contentHeight - scrollView.viewportHeight);
	const percent = Math.min(100, Math.max(0, Math.round((scrollView.scrollTop / scrollable) * 100)));
	const label = truncateToWidth(scrollToEndIndicator(rowsBelow, percent), clip.width, "…");
	const labelWidth = visibleWidth(label);
	const column = clip.x + Math.floor((clip.width - labelWidth) / 2);
	const rightEdge = scrollbarColumn ?? clip.x + clip.width;
	const availableWidth = Math.max(0, rightEdge - column);
	const text = truncateToWidth(label, availableWidth, "…");
	const textWidth = visibleWidth(text);
	if (textWidth === 0) return { screen };
	const result = [...screen];
	let base = result[row] ?? "";
	const covered = stripTerminalSequences(sliceByColumn(base, clip.x, column + textWidth - clip.x)).trimEnd();
	if (visibleWidth(covered) > column - clip.x - 1) {
		const blankWidth = rightEdge - clip.x;
		base = compositeTuiLine(base, " ".repeat(blankWidth), clip.x, blankWidth, width);
	}
	result[row] = compositeTuiLine(base, text, column, textWidth, width);
	return { screen: result, rect: { row, column, width: textWidth } };
}

/**
 * Right-align flash lines over the top rows of the screen, by the jump-to-end label's rule: text that ends at least one
 * cell before a flash stays beside it; a row the flash would cut mid-word is blanked, so no fragment shows.
 */
export function compositeFlashLines(screen: string[], flashLines: string[], width: number, height: number): string[] {
	if (flashLines.length === 0) return screen;
	const result = [...screen];
	while (result.length < height) result.push("");
	for (let row = 0; row < flashLines.length; row++) {
		const line = flashLines[row];
		const flashWidth = visibleWidth(line);
		if (flashWidth === 0) continue;
		const column = width - flashWidth;
		const base = result[row] ?? "";
		const text = stripTerminalSequences(sliceByColumn(base, 0, width)).trimEnd();
		const beside = isImageLine(base) || visibleWidth(text) <= column - 1;
		result[row] = compositeTuiLine(beside ? base : "", line, column, flashWidth, width);
	}
	return result;
}
