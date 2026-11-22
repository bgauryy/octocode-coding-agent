/**
 * A virtualized scroll view's frame: only the rows in view are laid out, from the item at the top of the view down,
 * or from the end up while the view follows the end. Items out of view keep the height the table has for them; one
 * still unmeasured is measured within the frame's budget or between frames, and an item measured above the rows in
 * view moves the scroll position by its change in height, so the rows in view stay where they are.
 */

import type { ContentSettler, ScrollLayoutNode } from "../layout-node.ts";
import { bindRenderIsolation, renderIsolated } from "../tui/render-isolation.ts";
import { intersect, type LayoutContext } from "./context.ts";
import type { LayoutBox, LayoutRect } from "./types.ts";
import type { VirtualDocument } from "./virtual-document.ts";

/** Time a frame may spend measuring items out of view, from its start; the first frame at a width measures none. */
const FRAME_BUDGET_MS = 6;
/**
 * Time measuring gets even when items rendered every frame (untracked ones) used up the frame's budget: otherwise the
 * frames would stop making progress, and the first scroll would measure everything at once.
 */
const MIN_MEASURE_MS = 2;

/** The items a frame draws, top first: `parts[i]` holds item `first + i`'s rows. */
interface ViewWindow {
	first: number;
	parts: string[][];
	/** Rows of the window above the first row in view. */
	rowsAbove: number;
}

export interface VirtualLayout {
	docBox: LayoutBox;
	content: Pick<LayoutBox, "scrollContentLines" | "scrollContentRow" | "scrollContentHeight" | "materialize">;
	settle: ContentSettler;
}

/** Whether a non-blank row ends the upward scan for a Kitty image crossing the top of the view. */
function hasText(lines: readonly string[], from: number): boolean {
	for (let row = from; row >= 0; row--) if (lines[row] !== "") return true;
	return false;
}

/** The rows in view while following the end, and above them up to a row that is not blank. */
function endWindow(doc: VirtualDocument, viewportHeight: number): ViewWindow {
	const parts: string[][] = [];
	let first = doc.items.length;
	let rows = 0;
	let scanEnds = false;
	while (first > 0 && (rows <= viewportHeight || !scanEnds)) {
		first--;
		const { lines } = doc.measure(first);
		const above = Math.max(0, rows + lines.length - viewportHeight) - Math.max(0, rows - viewportHeight);
		if (above > 0 && hasText(lines, above - 1)) scanEnds = true;
		rows += lines.length;
		parts.push(lines);
	}
	parts.reverse();
	return { first, parts, rowsAbove: Math.max(0, rows - viewportHeight) };
}

/**
 * The rows in view from the item at the top of the view down, and above them up to a row that is not blank. Undefined
 * when the content ends within the view: the view then shows the end.
 */
function anchoredWindow(
	doc: VirtualDocument,
	anchor: { index: number; offset: number },
	viewportHeight: number,
): (ViewWindow & { offset: number; growthAbove: number }) | undefined {
	const top = doc.measure(anchor.index).lines;
	const offset = Math.min(anchor.offset, Math.max(0, top.length - 1));
	const parts = [top];
	let below = top.length - offset;
	for (let index = anchor.index + 1; below < viewportHeight && index < doc.items.length; index++) {
		const { lines } = doc.measure(index);
		parts.push(lines);
		below += lines.length;
	}
	if (below < viewportHeight) return undefined;
	let first = anchor.index;
	let rowsAbove = offset;
	let growthAbove = 0;
	let scanEnds = offset > 0 && hasText(top, offset - 1);
	const above: string[][] = [];
	while (!scanEnds && first > 0) {
		first--;
		const { lines, delta } = doc.measure(first);
		growthAbove += delta;
		above.push(lines);
		rowsAbove += lines.length;
		scanEnds = hasText(lines, lines.length - 1);
	}
	return { first, parts: above.reverse().concat(parts), rowsAbove, offset, growthAbove };
}

/**
 * Lay out the rows in view of a virtualized scroll view. Undefined once every item is measured: the exact layout then
 * costs no more and takes over.
 */
export function layoutVirtual(
	context: LayoutContext,
	node: ScrollLayoutNode,
	doc: VirtualDocument,
	frame: { x: number; y: number; height: number; contentWidth: number; clip: LayoutRect },
): VirtualLayout | undefined {
	const start = performance.now();
	const { contentWidth } = frame;
	const state = node.state;
	const firstAtWidth = doc.width !== contentWidth || !doc.tableCurrent;
	const newWidth = doc.width !== contentWidth;
	if (newWidth) doc.exactWidth = undefined;
	if (!doc.prepare(node.component, contentWidth)) return undefined;
	// This frame draws the items one by one: the containers' rows at another width are not read again.
	if (newWidth) for (const container of doc.containers) container.releaseRenderCache();
	const viewportHeight = Math.max(0, Math.floor(frame.height));
	// Told first, so a pending `keepRowsInView` and clamping apply to the position the anchor is read from.
	const tell = (total: number): void => {
		state.updateLayout(total, viewportHeight, context.requestRender);
		doc.reported = total;
	};
	tell(doc.total);
	const scrollTop = state.scrollTop;

	// Following the end, or from the item at the top of the view down.
	let anchored: ReturnType<typeof anchoredWindow>;
	let offsetChange = 0;
	let shift = 0;
	const anchor = state.isFollowingEnd === true ? undefined : doc.locate(scrollTop);
	if (anchor && anchor.index < doc.items.length) {
		shift += doc.measureUnstable(anchor.index);
		anchored = anchoredWindow(doc, anchor, viewportHeight);
		if (anchored) {
			shift += anchored.growthAbove;
			offsetChange = anchored.offset - anchor.offset;
		}
	} else doc.measureUnstable(0);
	let window: ViewWindow = anchored ?? endWindow(doc, viewportHeight);
	const top = anchored ? anchor!.index : window.first;
	doc.prioritize(window.first, window.first + window.parts.length - 1, viewportHeight);
	const deadline = Math.max(start + FRAME_BUDGET_MS, performance.now() + MIN_MEASURE_MS);
	shift += doc.measurePending(top, firstAtWidth ? start : deadline, firstAtWidth ? 0 : 1);
	// The row the view starts on: the anchor's new place, or the end.
	let target = anchored ? scrollTop + shift + offsetChange : Math.max(0, doc.total - viewportHeight);

	if (doc.pendingCount === 0) {
		// Exact from here: the exact layout places the rows; the anchor keeps the rows in view.
		if (anchored) doc.shift(state, target - scrollTop);
		doc.exactWidth = contentWidth;
		return undefined;
	}
	doc.shift(state, target - scrollTop);
	tell(doc.total);
	if (anchored && state.scrollTop !== target) {
		// Measuring moved the end into the view: it shows the end.
		window = endWindow(doc, viewportHeight);
		anchored = undefined;
		target = Math.max(0, doc.total - viewportHeight);
		doc.shift(state, target - state.scrollTop);
		tell(doc.total);
	}
	const windowRows = window.parts.flat();
	const windowStart = anchored ? target - window.rowsAbove : doc.total - windowRows.length;
	return buildLayout(context, node, doc, { ...frame, viewportHeight, window, windowRows, windowStart });
}

function buildLayout(
	context: LayoutContext,
	node: ScrollLayoutNode,
	doc: VirtualDocument,
	at: {
		x: number;
		y: number;
		clip: LayoutRect;
		contentWidth: number;
		viewportHeight: number;
		window: ViewWindow;
		windowRows: string[];
		windowStart: number;
	},
): VirtualLayout {
	const { x, y, clip, contentWidth, viewportHeight, window, windowRows, windowStart } = at;
	const state = node.state;
	const scrollTop = state.scrollTop;
	const total = doc.total;
	const docRect = { x, y: y - scrollTop, width: contentWidth, height: total };
	const docBox: LayoutBox = {
		component: doc.view,
		rect: docRect,
		clip: intersect(clip, docRect),
		children: [],
		lines: windowRows,
		lineOffset: -windowStart,
		layer: 0,
	};
	// Items in view get their own boxes, so the pointer reaches them as it would through their containers.
	let top = windowStart;
	for (let part = 0; part < window.parts.length; part++) {
		const height = window.parts[part].length;
		const bottom = top + height;
		if (bottom > scrollTop && top < scrollTop + viewportHeight) {
			const rect = { x, y: y - scrollTop + top, width: contentWidth, height };
			const component = doc.items[window.first + part];
			docBox.children.push({ component, rect, clip: rect, children: [], parent: docBox, layer: 0 });
		}
		top = bottom;
	}
	doc.scheduleSlices(node.component, state, context.requestRender);

	let full: readonly string[] | undefined;
	/** Every item measured, the scroll position settled: the table is exact and the next frame lays out exactly. */
	const settleAll = (): void => {
		if (!doc.tableCurrent || doc.width !== contentWidth) return;
		if (!doc.matches(node.component) && !doc.prepare(node.component, contentWidth)) return;
		doc.shift(state, doc.measurePending(doc.locate(state.scrollTop).index, Number.POSITIVE_INFINITY));
		doc.exactWidth = contentWidth;
	};
	/**
	 * The whole content at this width, for search, selection and keys: measures the rest and settles the scroll position.
	 * Keys call it after the frame, so it runs under the frame's render isolation.
	 */
	const materialize = bindRenderIsolation((): readonly string[] => {
		if (full) return full;
		full = renderIsolated(node.component, contentWidth);
		settleAll();
		return full;
	});
	/**
	 * Measure the items a scroll up reaches: the rows from `rowsFromEnd` rows before the end of the content up to the top
	 * of the view. Measuring an item above the view moves the scroll position by its change, keeping the rows in view.
	 */
	let rowsFromEnd = 0;
	const settleRows = bindRenderIsolation((): void => {
		if (!doc.tableCurrent || doc.width !== contentWidth || doc.pendingCount === 0) return;
		if (!doc.matches(node.component) && !doc.prepare(node.component, contentWidth)) return;
		const scrollTopNow = state.scrollTop;
		const needed = rowsFromEnd - (doc.reported - scrollTopNow);
		if (needed <= 0) return;
		const anchor = doc.locate(scrollTopNow);
		if (anchor.index < doc.items.length && doc.isPending(anchor.index)) doc.measure(anchor.index);
		let covered = anchor.offset;
		let shift = 0;
		for (let index = anchor.index - 1; index >= 0 && covered < needed; index--) {
			if (doc.isPending(index)) shift += doc.measure(index).delta;
			covered += doc.heights[index];
		}
		doc.shift(state, shift);
		if (doc.pendingCount === 0) doc.exactWidth = contentWidth;
	});
	return {
		docBox,
		content: {
			get scrollContentLines() {
				return materialize();
			},
			get scrollContentRow() {
				// Between paints a measuring slice can shift the window. Pin its origin for the duration of a copy.
				const start = doc.rowOf(window.first, 0);
				return (row: number) => windowRows[row - start];
			},
			scrollContentHeight: total,
			materialize: () => {
				materialize();
			},
		},
		settle: {
			isSettled: () => doc.pendingCount === 0,
			cancel: () => doc.cancelSlices(),
			all: () => void materialize(),
			rows: (rows) => {
				rowsFromEnd = rows;
				settleRows();
			},
		},
	};
}
