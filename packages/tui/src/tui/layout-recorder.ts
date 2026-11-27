/**
 * The row layout of one frame: which leaf component's output starts on which row.
 *
 * A frame is a flat list of rows, but the rows come from a tree of components. When a row above the viewport
 * changes, the renderer must know whether the row's content was edited in place (a counter, a spinner mark, a
 * status word) or the layout moved (a component appeared, vanished, grew or shrank). Terminals cannot edit
 * scrollback, so an in-place edit is dropped from the diff, while a moved layout needs the whole transcript
 * replayed. `Container.render` reports its layout to the recorder that is active for the frame.
 *
 * Each container reports one node: its children, their rows, and the layouts rendered inside each child. An unchanged
 * container reports the node of its last frame by reference, so recording costs nothing for the parts of the tree that
 * did not change; the flat leaves and start rows are built only when asked for.
 */

import type { Component } from "./component.ts";

export interface LayoutLeaf {
	component: Component;
	start: number;
	/** Rows the leaf rendered. */
	length: number;
}

/** What one container rendered. Never changed after it is reported. */
export interface LayoutNode {
	readonly components: readonly Component[];
	/** Row where each component starts, relative to the node; the last entry is the total. */
	readonly offsets: readonly number[];
	/** The layouts rendered inside each child, or undefined where unknown (not recorded). */
	readonly nested: readonly (readonly NestedLayout[] | undefined)[] | undefined;
	/** Leaves the node reports: a child that reported no leaf of its own is a leaf itself. */
	readonly leafCount: number;
}

/** A node rendered inside a child, `offset` rows below the child's start. */
export interface NestedLayout {
	readonly node: LayoutNode;
	readonly offset: number;
}

const NO_NESTED: readonly NestedLayout[] = Object.freeze([]);

export function nestedLeafCount(nested: readonly NestedLayout[] | undefined): number {
	if (!nested) return 0;
	let count = 0;
	for (const entry of nested) count += entry.node.leafCount;
	return count;
}

function flatten(
	list: readonly NestedLayout[],
	start: number,
	leaves: LayoutLeaf[],
	starts: Map<Component, number>,
): void {
	for (const { node, offset } of list) {
		let row = start + offset;
		for (let index = 0; index < node.components.length; index++) {
			const component = node.components[index];
			const length = node.offsets[index + 1] - node.offsets[index];
			starts.set(component, row);
			const nested = node.nested?.[index];
			if (nested && nestedLeafCount(nested) > 0) flatten(nested, row, leaves, starts);
			else leaves.push({ component, start: row, length });
			row += length;
		}
	}
}

export class LayoutRecorder {
	/** Row where the container being rendered starts; `Container.render` sets it before rendering each child. */
	base = 0;
	private readonly roots: NestedLayout[] = [];
	/** Per child being rendered, outermost first: the layouts it rendered so far and the row it starts on. */
	private readonly open: Array<{ collected: NestedLayout[] | undefined; start: number }> = [];
	private flat: { leaves: LayoutLeaf[]; starts: Map<Component, number> } | undefined;

	/** A container starts rendering the child that starts at `start`; every `beginChild` is followed by `endChild`. */
	beginChild(start: number): void {
		this.open.push({ collected: undefined, start });
		this.base = start;
	}

	/** The layouts the child rendered since its `beginChild`. */
	endChild(): readonly NestedLayout[] {
		return this.open.pop()?.collected ?? NO_NESTED;
	}

	/** A container rendered `node`, starting at `base`. */
	attach(node: LayoutNode): void {
		this.flat = undefined;
		const child = this.open.at(-1);
		if (!child) this.roots.push({ node, offset: this.base });
		else (child.collected ??= []).push({ node, offset: this.base - child.start });
	}

	private flattened(): { leaves: LayoutLeaf[]; starts: Map<Component, number> } {
		if (!this.flat) {
			const leaves: LayoutLeaf[] = [];
			const starts = new Map<Component, number>();
			flatten(this.roots, 0, leaves, starts);
			this.flat = { leaves, starts };
		}
		return this.flat;
	}

	/** Every leaf with its start row, in render order. */
	get leaves(): readonly LayoutLeaf[] {
		return this.flattened().leaves;
	}

	/** The start row of every child a container rendered, leaf or not. */
	get starts(): ReadonlyMap<Component, number> {
		return this.flattened().starts;
	}
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
 * into the rows above it have the same length. Then a changed row above `row` was edited in place. A component
 * replaced by a new one of the same height (a header or status row rebuilt, a message re-created on invalidate) also
 * leaves every row where it was; a component that still exists elsewhere in the frame moved, so the layout did too.
 */
export function sameLayoutAbove(previous: readonly LayoutLeaf[], next: readonly LayoutLeaf[], row: number): boolean {
	const before = leavesReaching(previous, row);
	const after = leavesReaching(next, row);
	if (before.length !== after.length) return false;
	let replaced: { before: Set<unknown>; after: Set<unknown> } | undefined;
	return before.every((leaf, index) => {
		const other = after[index];
		// A leaf that starts at or below `row` may grow or shrink: only its place matters.
		const lengthMatters = leaf.start < row;
		if (other === undefined || leaf.start !== other.start || (lengthMatters && leaf.length !== other.length)) {
			return false;
		}
		if (leaf.component === other.component) return true;
		replaced ??= {
			before: new Set(before.map((entry) => entry.component)),
			after: new Set(after.map((entry) => entry.component)),
		};
		return !replaced.after.has(leaf.component) && !replaced.before.has(other.component);
	});
}
