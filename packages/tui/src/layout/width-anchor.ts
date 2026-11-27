import type { ScrollLayoutNode } from "../layout-node.ts";
import { VirtualDocument } from "./virtual-document.ts";

/** The width each non-virtualized scroll view was last laid out at. */
const laidOutWidths = new WeakMap<object, number>();

/** Items measured at `width`, to find the item holding a row and where each item starts. */
function measureItems(node: ScrollLayoutNode, width: number): VirtualDocument | undefined {
	const document = new VirtualDocument({
		render: (at) => node.component.render(at),
		invalidate: () => node.component.invalidate?.(),
	});
	if (!document.prepare(node.component, width)) {
		document.dispose();
		return undefined;
	}
	document.measurePending(0, Number.POSITIVE_INFINITY);
	return document;
}

function itemTop(document: VirtualDocument, index: number): number {
	let top = 0;
	for (let at = 0; at < index; at++) top += document.heights[at];
	return top;
}

/**
 * A reader scrolled up in a view that is not virtualized keeps the item at the top of the view across a width change:
 * the rows above it reflow, so the same `scrollTop` would show a different item. Moves the scroll position to the
 * item's new place before the layout reads it. Views following the end or at the start need no anchor.
 */
export function anchorOnWidthChange(node: ScrollLayoutNode, contentWidth: number): void {
	const { state } = node;
	const previousWidth = laidOutWidths.get(state);
	laidOutWidths.set(state, contentWidth);
	if (previousWidth === undefined || previousWidth === contentWidth) return;
	if (state.scrollTop <= 0 || state.isFollowingEnd === true || state.shiftContent === undefined) return;
	const before = measureItems(node, previousWidth);
	if (!before) return;
	let after: VirtualDocument | undefined;
	try {
		const { index, offset } = before.locate(state.scrollTop);
		const item = before.items[index];
		after = measureItems(node, contentWidth);
		const target = item === undefined ? -1 : after ? after.items.indexOf(item) : -1;
		if (!after || target < 0) return;
		const nextTop = itemTop(after, target) + Math.min(offset, Math.max(0, after.heights[target] - 1));
		state.shiftContent(nextTop - state.scrollTop);
	} finally {
		before.dispose();
		after?.dispose();
	}
}
