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

/** Columns left of a scrollbar where the pointer counts as approaching it. */
const NEAR_COLUMNS = 3;

/** Scrollbar hover highlighting and thumb or track dragging. */
export class AltScreenScrollbar {
	scrollbarDrag?: ScrollbarDrag;
	private scrollbarHover?: ScrollView;
	private readonly host: AltScreenScrollbarHost;
	private near = false;

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
		this.near = false;
		for (let dx = 0; dx <= NEAR_COLUMNS && !this.near; dx++)
			this.near = this.getScrollbarTargetAt(x + dx, y, true) !== undefined;
	}

	/**
	 * Whether bare pointer motion is worth tracking for the scrollbar: while it is hovered, or while it shows and the
	 * pointer was last seen beside it. A visible scrollbar alone does not ask for it: every cell the pointer crosses would
	 * become a report (xterm.js encodes them on the editor's UI thread). Wheel, click and drag reports still place it.
	 */
	wantsHover(primary: { readonly isScrollbarVisible: boolean } | undefined): boolean {
		return this.hovering || (this.near && primary?.isScrollbarVisible === true);
	}

	stopScrollbarHover(): void {
		this.setScrollbarHover(undefined);
		this.near = false;
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
