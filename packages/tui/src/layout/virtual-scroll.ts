import type { ScrollView } from "../components/scroll-view.ts";
import { getLayoutNode, type ScrollLayoutNode } from "../layout-node.ts";
import type { Component } from "../tui/component.ts";
import { renderRowFrame } from "../tui/container-walk.ts";
import { renderIsolatedWith } from "../tui/render-isolation.ts";
import { frameLines, isRowFrame, type RowSource, rowCount } from "../tui/row-source.ts";
import { intersect, type LayoutContext, renderCached, translateBox, updateClips } from "./context.ts";
import { rowAt, rowsBetween } from "./row-window.ts";
import type { LayoutBox, LayoutRect } from "./types.ts";
import { VirtualDocument } from "./virtual-document.ts";
import { layoutVirtual } from "./virtual-frame.ts";

type LayoutChild = (component: Component, x: number, y: number, width: number, clip: LayoutRect) => LayoutBox;

/** Signalled items at which a frame at an unchanged width is laid out virtually: an expand-all or a theme change. */
const MASS_CHANGE_ITEMS = 48;

const documents = new WeakMap<object, VirtualDocument>();

function documentFor(node: ScrollLayoutNode): VirtualDocument {
	let document = documents.get(node.state);
	if (!document) {
		document = new VirtualDocument({
			render: (width) => node.component.render(width),
			invalidate: () => node.component.invalidate?.(),
		});
		documents.set(node.state, document);
	}
	return document;
}

type ScrollContent = Pick<LayoutBox, "scrollContentLines" | "scrollContentRow" | "scrollContentHeight" | "materialize">;

function scrollBox(
	context: LayoutContext,
	node: ScrollLayoutNode,
	component: Component,
	rect: LayoutRect,
	clip: LayoutRect,
	childBox: LayoutBox,
	content: ScrollContent,
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

/** Items a virtualized frame left unmeasured at this width are measured now: the rows in view stay in place. */
function settlePending(node: ScrollLayoutNode, contentWidth: number): void {
	const document = documents.get(node.state);
	if (!document) return;
	if (document.tableCurrent && document.width === contentWidth && document.pendingCount > 0) {
		if (document.matches(node.component) || document.prepare(node.component, contentWidth)) {
			const top = document.locate(node.state.scrollTop).index;
			document.shift(node.state, document.measurePending(top, Number.POSITIVE_INFINITY));
		}
	}
	// The containers lay the document out from here: the table no longer describes the screen.
	document.tableCurrent = false;
	document.exactWidth = contentWidth;
}

/** A plain container's rows as a row frame (no array of every row is made), under render isolation. */
function documentRows(component: Component, width: number): RowSource | undefined {
	if (getLayoutNode(component)) return undefined;
	return renderIsolatedWith(component, width, () => renderRowFrame(component, width));
}

function layoutExact(
	context: LayoutContext,
	node: ScrollLayoutNode,
	component: Component,
	frame: { x: number; y: number; width: number; height: number | undefined; contentWidth: number; clip: LayoutRect },
	layoutChild: LayoutChild,
): LayoutBox {
	const { x, y, contentWidth, clip } = frame;
	if (node.state.virtualize) settlePending(node, contentWidth);
	const rect = (viewportHeight: number) => ({ x, y, width: frame.width, height: viewportHeight });
	const rows = frame.height === undefined ? undefined : documentRows(node.component, contentWidth);
	if (rows !== undefined && frame.height !== undefined) {
		// Only the rows in view are copied: search and selection join the rest when they read it.
		const contentHeight = rowCount(rows);
		const viewportHeight = Math.max(0, Math.floor(frame.height));
		node.state.updateLayout(contentHeight, viewportHeight, context.requestRender);
		const scrollTop = node.state.scrollTop;
		const docRect = { x, y: y - scrollTop, width: contentWidth, height: contentHeight };
		const childBox: LayoutBox = {
			component: node.component,
			rect: docRect,
			clip: intersect(clip, docRect),
			children: [],
			lines: rowsBetween(rows, scrollTop, scrollTop + viewportHeight),
			lineOffset: -scrollTop,
			layer: 0,
		};
		let lines: readonly string[] | undefined;
		return scrollBox(context, node, component, rect(viewportHeight), clip, childBox, {
			get scrollContentLines() {
				lines ??= isRowFrame(rows) ? frameLines(rows) : rows;
				return lines;
			},
			scrollContentRow: (row) => rowAt(rows, row),
			scrollContentHeight: contentHeight,
		});
	}
	const previousScrollTop = node.state.scrollTop;
	const childBox = layoutChild(node.component, x, y - previousScrollTop, contentWidth, clip);
	const contentHeight = childBox.rect.height;
	const viewportHeight = frame.height === undefined ? contentHeight : Math.max(0, Math.floor(frame.height));
	node.state.updateLayout(contentHeight, viewportHeight, context.requestRender);
	translateBox(childBox, previousScrollTop - node.state.scrollTop);
	const lines = renderCached(context, node.component, contentWidth);
	return scrollBox(context, node, component, rect(viewportHeight), clip, childBox, {
		scrollContentLines: lines,
		scrollContentRow: (row) => lines[row],
		scrollContentHeight: lines.length,
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
	let virtual: ReturnType<typeof layoutVirtual>;
	// A scrollbar draws the position among every row: with heights still estimated it would be off, so it is exact.
	const scrollbarShown = state.isScrollbarVisible === true || state.scrollbar === "always";
	if (state.virtualize === true && height !== undefined && !scrollbarShown) {
		const document = documentFor(node);
		// After a width change, the first frame, or a change to many items at once (expand all, a new theme), only the
		// rows in view are laid out now; the rest are measured over the next frames and between them.
		if (document.exactWidth === contentWidth && document.signalledCount() >= MASS_CHANGE_ITEMS)
			document.exactWidth = undefined;
		if (document.exactWidth !== contentWidth)
			virtual = layoutVirtual(context, node, document, { ...frame, height, contentWidth });
	}
	state.setContentSettler?.(virtual?.settle);
	if (!virtual) return layoutExact(context, node, component, { ...frame, contentWidth }, layoutChild);
	const rect = { x: frame.x, y: frame.y, width: frame.width, height: Math.max(0, Math.floor(height!)) };
	return scrollBox(context, node, component, rect, frame.clip, virtual.docBox, virtual.content);
}
