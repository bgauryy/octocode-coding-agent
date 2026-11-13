/**
 * What a container remembers between frames, and the registry that lets the walk (`container-walk.ts`) and read-only
 * walkers reach a container's state and live children without going through `children`, which counts as an edit.
 */

import type { Component } from "./component.ts";
import type { LayoutNode } from "./layout-recorder.ts";
import type { RowFrame } from "./row-source.ts";

export interface ContainerFrame extends LayoutNode {
	readonly width: number;
	readonly components: readonly Component[];
	/** The rows, which a frame that only changed which children are volatile shares with the frame before it. */
	readonly rows: RowFrame;
	/** Row where each child starts; the last entry is the total. */
	readonly offsets: readonly number[];
	/** Every child's nested layout is known: the frame can be reported without rendering a child again. */
	readonly recorded: boolean;
	/** Children (ascending indices) whose rows may change without a signal: untracked, volatile or failed. */
	readonly unstable: readonly number[];
	/** A child appears twice: a signal cannot say which place changed. */
	readonly duplicates: boolean;
}

/** A container's render memory between frames. */
export class ContainerRenderState {
	frame: ContainerFrame | undefined;
	/** Linked children that signalled since the last walk started. */
	dirty: Set<Component> | undefined;
	/** A signal reached this container since its last walk started: parents already heard about it. */
	signaled = false;
	/** The children list may have changed: read through `children`, added, removed or replaced. */
	structureChanged = true;
	/**
	 * Where the children were last painted: it outlives `invalidate` and `releaseRenderCache`, so a click lands where the
	 * rows were drawn and never makes the children render again.
	 */
	painted: { width: number; components: readonly Component[]; offsets: readonly number[] } | undefined;

	paint(frame: ContainerFrame): void {
		const painted = this.painted;
		if (painted?.offsets !== frame.offsets || painted.components !== frame.components || painted.width !== frame.width)
			this.painted = { width: frame.width, components: frame.components, offsets: frame.offsets };
	}
}

export const states = new WeakMap<Component, ContainerRenderState>();
/** `Container.prototype`: a child whose `render` is its `render` hands its parent a row frame instead of an array. */
let containerPrototype: { render(width: number): string[] } | undefined;
/** A container's live children list. */
let childrenOf: (container: Component) => readonly Component[] = () => [];

export function registerContainerState(container: Component, state: ContainerRenderState): void {
	states.set(container, state);
}

export function registerContainerPrototype(
	prototype: { render(width: number): string[] },
	children: (container: Component) => readonly Component[],
): void {
	containerPrototype = prototype;
	childrenOf = children;
}

/** Whether `component` renders as `Container.prototype.render` does, so it can hand over a row frame. */
export function rendersAsContainer(component: Component): boolean {
	return component.render === containerPrototype?.render;
}

/** The live children list of a registered container. */
export function containerChildren(container: Component): readonly Component[] {
	return childrenOf(container);
}

/**
 * A container's live children, read without counting as an edit: for walkers that never change the list (focus checks,
 * the virtualized scroll view's items). Undefined for a component that is not a `Container`.
 */
export function readChildren(component: Component): readonly Component[] | undefined {
	return states.has(component) ? childrenOf(component) : undefined;
}

/** Where a container last painted its children (it outlives `releaseRenderCache`); undefined before its first walk. */
export function paintedChildren(component: Component): ContainerRenderState["painted"] {
	return states.get(component)?.painted;
}

/** Children that signalled since the container's last walk: its next frame renders them again. */
export function signalledChildren(component: Component): ReadonlySet<Component> | undefined {
	return states.get(component)?.dirty;
}

let structureVersion = 0;

/** Count a possible edit of some container's children list: an add, a removal, or a read through `children`. */
export function noteStructureChange(): void {
	structureVersion++;
}

/** Changes with every possible edit of any container's children list: a walk of the tree is good while it stays. */
export function containerStructureVersion(): number {
	return structureVersion;
}
