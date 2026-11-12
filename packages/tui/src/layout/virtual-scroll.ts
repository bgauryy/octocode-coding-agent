import type { ScrollView } from "../components/scroll-view.ts";
import type { ScrollLayoutNode } from "../layout-node.ts";
import type { Component } from "../tui/component.ts";
import { Container } from "../tui/container.ts";
import { bindRenderIsolation, renderIsolated } from "../tui/render-isolation.ts";
import { intersect, type LayoutContext, renderCached, translateBox, updateClips } from "./context.ts";
import type { LayoutBox, LayoutRect } from "./types.ts";

/** Time a frame may spend measuring rows out of view after the first frame at a width. */
const FRAME_MEASURE_BUDGET_MS = 6;

type LayoutChild = (component: Component, x: number, y: number, width: number, clip: LayoutRect) => LayoutBox;

/** What a virtualized scroll view remembers between frames. */
interface VirtualDocument {
	/** Width of the last frame that rendered every item, or undefined while some are unmeasured. */
	exactWidth: number | undefined;
	lastWidth: number | undefined;
	/** Each item's height at the width it was last rendered. */
	heights: WeakMap<Component, { width: number; height: number }>;
	/** Items whose height the last frame estimated, with the estimate: measuring them corrects the scroll position. */
	estimated: Map<Component, number>;
	/** The content box's component: draws like the document and takes no mouse events, which go to the items. */
	view: Component;
}

const documents = new WeakMap<object, VirtualDocument>();

function documentFor(node: ScrollLayoutNode): VirtualDocument {
	let document = documents.get(node.state);
	if (!document) {
		document = {
			exactWidth: undefined,
			lastWidth: undefined,
			heights: new WeakMap(),
			estimated: new Map(),
			view: { render: (width) => node.component.render(width), invalidate: () => node.component.invalidate?.() },
		};
		documents.set(node.state, document);
	}
	return document;
}

/** A plain `Container` renders exactly its children's rows in order, so the document is the leaves of plain containers. */
function documentItems(component: Component, items: Component[] = [], containers?: Container[]): Component[] {
	if (
		component instanceof Container &&
		Object.getPrototypeOf(component) === Container.prototype &&
		component.render === Container.prototype.render
	) {
		containers?.push(component);
		for (const child of component.children) documentItems(child, items, containers);
	} else items.push(component);
	return items;
}

function scrollBox(
	context: LayoutContext,
	node: ScrollLayoutNode,
	component: Component,
	rect: LayoutRect,
	clip: LayoutRect,
	childBox: LayoutBox,
	content: Pick<LayoutBox, "scrollContentLines" | "scrollContentRow" | "materialize">,
): LayoutBox {
	const scrollView = node.state as ScrollView;
	if (node.state.primary || !context.primaryScrollView) context.primaryScrollView = scrollView;
	const childClip = intersect(clip, rect);
	// Descriptors, not a spread: a virtualized frame's content is a getter that measures only when read.
	const box = Object.defineProperties(
		{ component, rect, clip: childClip, children: [childBox], scrollView, layer: 0 },
		Object.getOwnPropertyDescriptors(content),
	) as LayoutBox;
	childBox.parent = box;
	updateClips(childBox, childClip);
	return box;
}

/** Measuring the items the last frame estimated: the scroll position moves by the difference, keeping the rows in view. */
function settleEstimates(context: LayoutContext, node: ScrollLayoutNode, contentWidth: number): void {
	const document = documents.get(node.state);
	if (!document) return;
	if (document.estimated.size > 0 && document.lastWidth === contentWidth) {
		const present = new Set(documentItems(node.component));
		let rows = 0;
		for (const [item, estimate] of document.estimated) {
			if (present.has(item)) rows += renderCached(context, item, contentWidth).length - estimate;
		}
		node.state.shiftContent?.(rows);
	}
	if (document.estimated.size > 0) document.estimated = new Map();
	document.exactWidth = contentWidth;
	document.lastWidth = contentWidth;
}

function layoutExact(
	context: LayoutContext,
	node: ScrollLayoutNode,
	component: Component,
	frame: { x: number; y: number; width: number; height: number | undefined; contentWidth: number; clip: LayoutRect },
	layoutChild: LayoutChild,
): LayoutBox {
	const { x, y, contentWidth, clip } = frame;
	if (node.state.virtualize) settleEstimates(context, node, contentWidth);
	const previousScrollTop = node.state.scrollTop;
	const childBox = layoutChild(node.component, x, y - previousScrollTop, contentWidth, clip);
	const contentHeight = childBox.rect.height;
	const viewportHeight = frame.height === undefined ? contentHeight : Math.max(0, Math.floor(frame.height));
	node.state.updateLayout(contentHeight, viewportHeight, context.requestRender);
	translateBox(childBox, previousScrollTop - node.state.scrollTop);
	const lines = renderCached(context, node.component, contentWidth);
	const rect = { x, y, width: frame.width, height: viewportHeight };
	return scrollBox(context, node, component, rect, clip, childBox, {
		scrollContentLines: lines,
		scrollContentRow: (row) => lines[row],
	});
}

/**
 * The rows in view, laid out from the end: following the end, the visible rows are the last ones whatever the heights
 * above them, so items out of view keep their last known height until measured. Undefined when every item got
 * measured, so the exact layout costs no more.
 */
function layoutVirtual(
	context: LayoutContext,
	node: ScrollLayoutNode,
	component: Component,
	frame: { x: number; y: number; width: number; height: number; contentWidth: number; clip: LayoutRect },
): LayoutBox | undefined {
	const { x, y, contentWidth, clip } = frame;
	const document = documentFor(node);
	const containers: Container[] = [];
	const items = documentItems(node.component, [], containers);
	const viewportHeight = Math.max(0, Math.floor(frame.height));
	const widthChanged = document.lastWidth !== contentWidth;
	const previousEstimates = widthChanged ? new Map<Component, number>() : document.estimated;
	const heights: number[] = Array.from({ length: items.length }, () => 0);
	const measure = (index: number): string[] => {
		const lines = renderCached(context, items[index], contentWidth);
		document.heights.set(items[index], { width: contentWidth, height: lines.length });
		heights[index] = lines.length;
		return lines;
	};

	// The rows in view, and above them up to a row that is not blank, where the Kitty image crop scan stops.
	const suffix: string[][] = [];
	let first = items.length;
	let suffixRows = 0;
	let scanEnds = false;
	while (first > 0 && (suffixRows <= viewportHeight || !scanEnds)) {
		first--;
		const lines = measure(first);
		const above = Math.max(0, suffixRows + lines.length - viewportHeight) - Math.max(0, suffixRows - viewportHeight);
		for (let row = above - 1; row >= 0 && !scanEnds; row--) if (lines[row] !== "") scanEnds = true;
		suffixRows += lines.length;
		suffix.push(lines);
	}
	if (first === 0) return undefined;

	// Items above: rendered when measured at this width (cheap, and picks up changes), else within the frame's budget.
	const estimated = new Map<Component, number>();
	const deadline = widthChanged ? 0 : performance.now() + FRAME_MEASURE_BUDGET_MS;
	for (let index = first - 1; index >= 0; index--) {
		const known = document.heights.get(items[index]);
		if (known?.width === contentWidth || performance.now() < deadline) measure(index);
		else {
			heights[index] = known?.height ?? 1;
			estimated.set(items[index], heights[index]);
		}
	}
	if (estimated.size === 0) return undefined;

	let correction = 0;
	for (let index = 0; index < items.length; index++) {
		const previous = previousEstimates.get(items[index]);
		if (previous !== undefined) correction += heights[index] - previous;
	}
	node.state.shiftContent?.(correction);
	// This frame draws the items one by one: the containers' joined rows are not read until a full layout joins them again.
	for (const container of containers) container.releaseRenderCache();
	document.estimated = estimated;
	document.lastWidth = contentWidth;
	document.exactWidth = undefined;
	context.requestRender();

	const contentHeight = heights.reduce((sum, height) => sum + height, 0);
	node.state.updateLayout(contentHeight, viewportHeight, context.requestRender);
	const scrollTop = node.state.scrollTop;
	const suffixStart = contentHeight - suffixRows;
	const window = suffix.reverse().flat();
	const docRect = { x, y: y - scrollTop, width: contentWidth, height: contentHeight };
	const docBox: LayoutBox = {
		component: document.view,
		rect: docRect,
		clip: intersect(clip, docRect),
		children: [],
		lines: window,
		lineOffset: -suffixStart,
		layer: 0,
	};
	// Items in view get their own boxes, so the pointer reaches them as it would through their containers.
	let top = suffixStart;
	for (let index = first; index < items.length; index++) {
		const bottom = top + heights[index];
		if (bottom > scrollTop && top < scrollTop + viewportHeight) {
			const rect = { x, y: y - scrollTop + top, width: contentWidth, height: heights[index] };
			docBox.children.push({ component: items[index], rect, clip: rect, children: [], parent: docBox, layer: 0 });
		}
		top = bottom;
	}

	let full: readonly string[] | undefined;
	/**
	 * The whole content at this width, for search, selection and keys: measures the rest and settles the scroll position.
	 * Keys call it after the frame, so it runs under the frame's render isolation.
	 */
	const materialize = bindRenderIsolation((): readonly string[] => {
		if (full) return full;
		full = renderIsolated(node.component, contentWidth);
		if (document.estimated === estimated) {
			let rows = 0;
			for (const [item, estimate] of estimated) rows += renderIsolated(item, contentWidth).length - estimate;
			node.state.shiftContent?.(rows);
			document.estimated = new Map();
			document.exactWidth = contentWidth;
		}
		return full;
	});
	const rect = { x, y, width: frame.width, height: viewportHeight };
	return scrollBox(context, node, component, rect, clip, docBox, {
		get scrollContentLines() {
			return materialize();
		},
		scrollContentRow: (row) => window[row - suffixStart],
		materialize: () => {
			materialize();
		},
	});
}

/** Lay out a scroll view: its content, the scroll position and the rows in view. */
export function layoutScroll(
	context: LayoutContext,
	node: ScrollLayoutNode,
	component: Component,
	frame: { x: number; y: number; width: number; height: number | undefined; clip: LayoutRect },
	layoutChild: LayoutChild,
): LayoutBox {
	const contentWidth = node.state.getContentWidth(frame.width);
	const { height } = frame;
	const state = node.state;
	const canVirtualize =
		state.virtualize === true &&
		height !== undefined &&
		state.isFollowingEnd === true &&
		state.isScrollbarVisible !== true &&
		state.scrollbar !== "always" &&
		documents.get(state)?.exactWidth !== contentWidth;
	const virtual = canVirtualize
		? layoutVirtual(context, node, component, { ...frame, height, contentWidth })
		: undefined;
	state.setContentSettler?.(virtual?.materialize);
	return virtual ?? layoutExact(context, node, component, { ...frame, contentWidth }, layoutChild);
}
