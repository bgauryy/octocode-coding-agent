import type { ScrollView } from "../components/scroll-view.ts";
import { getScrollbarGeometry, getScrollViewBox, type LayoutFrame } from "../layout.ts";
import { isImageLine } from "../terminal-image.ts";
import { compositeTuiLine } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";
import type { ScrollToEndIndicatorRect } from "./types.ts";

/**
 * Center the jump-to-end label on the last row of a follow-end scroll view that is scrolled away
 * from its end. Returns the clickable rectangle when the label was drawn.
 */
export function compositeScrollToEndIndicator(
	screen: string[],
	layout: LayoutFrame,
	width: number,
	implicitScrollView: ScrollView,
	scrollToEndIndicator: (() => string) | undefined,
): { screen: string[]; rect?: ScrollToEndIndicatorRect } {
	const scrollView = layout.primaryScrollView ?? implicitScrollView;
	if (!scrollToEndIndicator || !scrollView.followEnd || scrollView.isFollowingEnd) return { screen };
	const box = getScrollViewBox(layout, scrollView);
	const clip = box?.clip;
	if (!clip || clip.width <= 0 || clip.height <= 0) return { screen };
	const row = clip.y + clip.height - 1;
	if (row >= screen.length || isImageLine(screen[row] ?? "")) return { screen };
	const scrollbarColumn = box ? getScrollbarGeometry(box)?.column : undefined;
	const label = truncateToWidth(scrollToEndIndicator(), clip.width, "");
	const labelWidth = visibleWidth(label);
	const column = clip.x + Math.floor((clip.width - labelWidth) / 2);
	const rightEdge = scrollbarColumn ?? clip.x + clip.width;
	const availableWidth = Math.max(0, rightEdge - column);
	const text = truncateToWidth(label, availableWidth, "");
	const textWidth = visibleWidth(text);
	if (textWidth === 0) return { screen };
	const result = [...screen];
	result[row] = compositeTuiLine(result[row] ?? "", text, column, textWidth, width);
	return { screen: result, rect: { row, column, width: textWidth } };
}

/** Right-align flash lines over the top rows of the screen. */
export function compositeFlashLines(screen: string[], flashLines: string[], width: number, height: number): string[] {
	if (flashLines.length === 0) return screen;
	const result = [...screen];
	while (result.length < height) result.push("");
	for (let row = 0; row < flashLines.length; row++) {
		const line = flashLines[row];
		const flashWidth = visibleWidth(line);
		if (flashWidth === 0) continue;
		result[row] = compositeTuiLine(result[row] ?? "", line, width - flashWidth, flashWidth, width);
	}
	return result;
}
