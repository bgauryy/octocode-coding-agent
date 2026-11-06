/**
 * The row layout of one frame: which leaf component's output starts on which row.
 *
 * A frame is a flat list of rows, but the rows come from a tree of components. When a row above the viewport
 * changes, the renderer must know whether the row's content was edited in place (a counter, a spinner mark, a
 * status word) or the layout moved (a component appeared, vanished, grew or shrank). Terminals cannot edit
 * scrollback, so an in-place edit is dropped from the diff, while a moved layout needs the whole transcript
 * replayed. `Container.render` reports each leaf to the recorder that is active for the frame.
 */

import type { Component } from "./component.ts";

export interface LayoutLeaf {
	component: Component;
	start: number;
	/** Rows the leaf rendered. */
	length: number;
}

export class LayoutRecorder {
	/** Row where the container being rendered starts; `Container.render` sets it before rendering each child. */
	base = 0;
	/** Every leaf with its start row, in render order. */
	readonly leaves: LayoutLeaf[] = [];
}

let active: LayoutRecorder | undefined;

/** Run `render` with `recorder` collecting the layout of every `Container.render` inside it. */
export function recordLayout<T>(recorder: LayoutRecorder, render: () => T): T {
	const previous = active;
	active = recorder;
	try {
		return render();
	} finally {
		active = previous;
	}
}

export function activeLayoutRecorder(): LayoutRecorder | undefined {
	return active;
}

/** The leaves up to and including the first one starting at or after `row`: those that reach into the rows above it. */
function leavesReaching(leaves: readonly LayoutLeaf[], row: number): readonly LayoutLeaf[] {
	const end = leaves.findIndex((leaf) => leaf.start >= row);
	return end === -1 ? leaves : leaves.slice(0, end + 1);
}

/**
 * Whether every row above `row` kept its place: the same components start on the same rows and the leaves that reach
 * into the rows above it have the same length. Then a changed row above `row` was edited in place.
 */
export function sameLayoutAbove(previous: readonly LayoutLeaf[], next: readonly LayoutLeaf[], row: number): boolean {
	const before = leavesReaching(previous, row);
	const after = leavesReaching(next, row);
	return (
		before.length === after.length &&
		before.every((leaf, index) => {
			const other = after[index];
			// A leaf that starts at or below `row` may grow or shrink: only its place matters.
			const lengthMatters = leaf.start < row;
			return (
				other !== undefined &&
				leaf.start === other.start &&
				leaf.component === other.component &&
				(!lengthMatters || leaf.length === other.length)
			);
		})
	);
}
