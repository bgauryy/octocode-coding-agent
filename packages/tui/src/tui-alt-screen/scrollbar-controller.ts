import type { ScrollView } from "../components/scroll-view.ts";
import type { LayoutFrame } from "../layout/types.ts";
import { getScrollbarGeometry } from "../layout/scrollbar.ts";
import { getScrollViewBox, getScrollViewsAt } from "../layout.ts";
import { scrollScrollbarToPointer } from "./selection.ts";
import type { ScrollbarDrag, ScrollbarTarget, SgrMouseEvent } from "./types.ts";

/** Alternate-screen state and operations scrollbar hover and dragging read and call live. */
export interface AltScreenScrollbarHost {
	getCurrentLayout(): LayoutFrame | undefined;
	hasOverlay(): boolean;
	/** Drop the text selection and multi-click history when a scrollbar press starts a drag. */
	resetTextSelection(): void;
}

/** Scrollbar hover highlighting and thumb or track dragging. */
export class AltScreenScrollbar {
	scrollbarDrag?: ScrollbarDrag;
	private scrollbarHover?: ScrollView;
	private readonly host: AltScreenScrollbarHost;

	constructor(host: AltScreenScrollbarHost) {
		this.host = host;
	}

	private getScrollbarTargetAt(x: number, y: number, includeHiddenAuto = false): ScrollbarTarget | undefined {
		const currentLayout = this.host.getCurrentLayout();
		if (this.host.hasOverlay() || !currentLayout) return undefined;
		for (const scrollView of getScrollViewsAt(currentLayout, x, y)) {
			const box = getScrollViewBox(currentLayout, scrollView);
			const geometry = box ? getScrollbarGeometry(box, includeHiddenAuto) : undefined;
			if (geometry && x === geometry.column && y >= geometry.trackTop && y < geometry.trackTop + geometry.trackHeight) {
				return { scrollView, geometry };
			}
		}
		return undefined;
	}

	private setScrollbarHover(scrollView: ScrollView | undefined): void {
		if (scrollView === this.scrollbarHover) return;
		this.scrollbarHover?.setScrollbarActive(false);
		this.scrollbarHover = scrollView;
		this.scrollbarHover?.setScrollbarActive(true);
	}

	updateScrollbarHover(x: number, y: number): void {
		this.setScrollbarHover(this.getScrollbarTargetAt(x, y, true)?.scrollView);
	}

	stopScrollbarHover(): void {
		this.setScrollbarHover(undefined);
	}

	/** Whether the pointer was last seen over a scrollbar. */
	get hovering(): boolean {
		return this.scrollbarHover !== undefined;
	}

	handleScrollbarMouseEvent(event: SgrMouseEvent): boolean {
		if (this.scrollbarDrag) {
			if (event.release) {
				this.stopScrollbarDrag();
				return true;
			}
			const currentLayout = this.host.getCurrentLayout();
			const box = currentLayout ? getScrollViewBox(currentLayout, this.scrollbarDrag.scrollView) : undefined;
			const geometry = box ? getScrollbarGeometry(box) : undefined;
			if (geometry) {
				scrollScrollbarToPointer(this.scrollbarDrag.scrollView, geometry, event.y, this.scrollbarDrag.grabOffset);
			}
			return true;
		}

		if (event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0) return false;
		const target = this.getScrollbarTargetAt(event.x, event.y);
		if (!target) return false;
		this.host.resetTextSelection();
		this.setScrollbarHover(target.scrollView);
		const onThumb =
			event.y >= target.geometry.thumbTop && event.y < target.geometry.thumbTop + target.geometry.thumbHeight;
		if (!onThumb) {
			const direction = event.y < target.geometry.thumbTop ? -1 : 1;
			target.scrollView.scrollBy(direction * target.scrollView.viewportHeight);
			return true;
		}
		const grabOffset = event.y - target.geometry.thumbTop;
		this.scrollbarDrag = {
			scrollView: target.scrollView,
			grabOffset,
		};
		return true;
	}

	stopScrollbarDrag(): void {
		this.scrollbarDrag = undefined;
	}
}
