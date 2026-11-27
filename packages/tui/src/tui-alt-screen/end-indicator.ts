import type { ScrollView } from "../components/scroll-view.ts";
import type { LayoutFrame } from "../layout/types.ts";
import { getScrollViewBox } from "../layout.ts";
import { compositeScrollToEndIndicator } from "./compose.ts";
import type { ScrollToEndIndicatorLabel, ScrollToEndIndicatorRect } from "./types.ts";

/**
 * The jump-to-latest label of a view scrolled away from its end, and how many rows arrived below since: rows that grow
 * the content while the reader's position holds are new output. A reader position that moved with the growth (rows
 * measured or loaded above) is not, and the count never exceeds the rows still below. Back at the end, it resets.
 */
export class ScrollToEndIndicator {
	/** Where the label was drawn in the last frame, for clicks. */
	rect?: ScrollToEndIndicatorRect;
	private readonly label: ScrollToEndIndicatorLabel | undefined;
	private last?: { scrollView: ScrollView; scrollTop: number; contentHeight: number };
	private arrived = 0;

	constructor(label: ScrollToEndIndicatorLabel | undefined) {
		this.label = label;
	}

	/** Rows that arrived below the reader since the view left its end. */
	get newRows(): number {
		return this.arrived;
	}

	composite(screen: string[], layout: LayoutFrame, width: number, implicitScrollView: ScrollView): string[] {
		this.track(layout.primaryScrollView ?? implicitScrollView, layout);
		const label = this.label;
		const result = compositeScrollToEndIndicator(
			screen,
			layout,
			width,
			implicitScrollView,
			label && ((rowsBelow, percent) => label(rowsBelow, percent, this.arrived)),
		);
		this.rect = result.rect;
		return result.screen;
	}

	private track(scrollView: ScrollView, layout: LayoutFrame): void {
		if (!scrollView.followEnd || scrollView.isFollowingEnd) {
			this.last = undefined;
			this.arrived = 0;
			return;
		}
		const box = getScrollViewBox(layout, scrollView);
		const contentHeight = box?.scrollContentHeight ?? box?.scrollContentLines?.length ?? scrollView.scrollHeight;
		const last = this.last;
		if (last?.scrollView === scrollView && last.scrollTop === scrollView.scrollTop) {
			this.arrived += Math.max(0, contentHeight - last.contentHeight);
		}
		const rowsBelow = Math.max(0, contentHeight - scrollView.scrollTop - scrollView.viewportHeight);
		this.arrived = Math.min(this.arrived, rowsBelow);
		this.last = { scrollView, scrollTop: scrollView.scrollTop, contentHeight };
	}
}
