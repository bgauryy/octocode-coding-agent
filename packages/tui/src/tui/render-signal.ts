/**
 * Render change signals: when a parent may keep a child's rows from the last frame without rendering the child again.
 *
 * Every frame used to call `render` on every component of the tree and compare the returned arrays. Most of a long
 * transcript does not change between frames, so a parent may skip a child that is *tracked* and *quiet*:
 *
 * - tracked: the class declared with `trackRenderChanges` that its rows change only (a) after it calls
 *   `renderChanged(this)`, (b) in `invalidate`, which signals too, (c) through child components it linked with
 *   `linkRenderChild`, whose own signals reach it, or (d) with the width;
 * - quiet: it has not signalled since the parent last rendered it, and that render drew nothing volatile below it.
 *
 * Everything else is rendered every frame as before: a component that does not take part, a subclass that overrides a
 * tracked `render` without declaring it again, a composite whose child is volatile, a child that failed to render.
 */

import type { Component } from "./component.ts";

/** Implemented by containers: a linked child signalled. Other composites just pass the signal on to their parents. */
export const CHILD_RENDER_CHANGED = Symbol("octocode.childRenderChanged");

interface ChildChangeHandler {
	[CHILD_RENDER_CHANGED](child: Component): void;
}

interface RenderTrack {
	/** Components that render this one and must hear its signals. */
	parents: Component[] | undefined;
	/** Draws children: its rows are stable only when its last render settled and drew no volatile child. */
	composite: boolean;
	/** Serial of the composite's last settled render. */
	served: number;
	volatile: boolean;
	/** Container walk bookkeeping: the walk that last saw this component as a child. */
	markEpoch: number;
}

/** Prototypes whose own `render` was declared, and per instance prototype the answer of `isRenderTracked`. */
const trackedPrototypes = new WeakSet<object>();
const trackedByPrototype = new WeakMap<object, boolean>();
const tracks = new WeakMap<Component, RenderTrack>();
let serial = 0;

/**
 * Declare that components whose `render` is `prototype.render` change their rows only after a signal (see the module
 * comment). A subclass that overrides `render` is not tracked until it declares its own.
 */
export function trackRenderChanges(prototype: { render(width: number): string[] }): void {
	trackedPrototypes.add(prototype);
}

/** The object in the prototype chain that owns the `render` a component uses: the one that declared it. */
function renderOwner(start: object | null): object | null {
	let owner = start;
	while (owner && !Object.prototype.hasOwnProperty.call(owner, "render")) owner = Object.getPrototypeOf(owner);
	return owner;
}

/** Whether the `render` this component uses was declared with `trackRenderChanges`. */
function isRenderTracked(component: Component): boolean {
	// A component with its own `render` property replaced the declared one.
	if (Object.prototype.hasOwnProperty.call(component, "render")) return trackedPrototypes.has(component);
	const prototype = Object.getPrototypeOf(component) as object | null;
	if (!prototype) return false;
	let tracked = trackedByPrototype.get(prototype);
	if (tracked === undefined) {
		const owner = renderOwner(prototype);
		tracked = owner !== null && trackedPrototypes.has(owner);
		trackedByPrototype.set(prototype, tracked);
	}
	return tracked;
}

export function renderTrack(component: Component): RenderTrack {
	let track = tracks.get(component);
	if (!track) {
		track = { parents: undefined, composite: false, served: 0, volatile: false, markEpoch: 0 };
		tracks.set(component, track);
	}
	return track;
}

/** Mark `component` as one that draws children, so a render that did not settle counts as volatile. */
export function markRenderComposite(component: Component): void {
	renderTrack(component).composite = true;
}

/** `parent` renders `child`: the child's signals reach the parent. Linking twice is harmless. */
export function linkRenderChild(parent: Component, child: Component): void {
	markRenderComposite(parent);
	const track = renderTrack(child);
	if (!track.parents) track.parents = [parent];
	else if (!track.parents.includes(parent)) track.parents.push(parent);
}

/** `parent` no longer renders `child`. */
export function unlinkRenderChild(parent: Component, child: Component): void {
	const parents = tracks.get(child)?.parents;
	if (!parents) return;
	const index = parents.indexOf(parent);
	if (index !== -1) parents.splice(index, 1);
}

/**
 * `parent` now renders `next` in place of `previous` (an edit of its children list): every child of `next` is linked, and
 * each child of `previous` that left is unlinked. Returns the children unlinked: a signal one of them sends while unlinked
 * reaches nobody, so a parent that skips quiet children marks them changed, and one that comes back renders again.
 */
export function relinkRenderChildren(
	parent: Component,
	previous: readonly Component[],
	next: readonly Component[],
): Component[] {
	const kept = next.length > 0 ? new Set(next) : undefined;
	const gone: Component[] = [];
	for (const child of previous) {
		if (kept?.has(child)) continue;
		unlinkRenderChild(parent, child);
		gone.push(child);
	}
	for (const child of next) linkRenderChild(parent, child);
	return gone;
}

/**
 * Tell every component that renders `component` that its rows may have changed.
 *
 * A parent that nothing renders through a link (a detached subtree, or a root drawn directly) is told once and then
 * unlinked, so a component that outlives the parents it was shown in does not keep them alive or keep telling them:
 * a container keeps the child among those it renders again and links it again when it does, and a composite links its
 * children again whenever it renders.
 */
export function renderChanged(component: Component): void {
	const parents = tracks.get(component)?.parents;
	if (!parents) return;
	for (let index = parents.length - 1; index >= 0; index--) {
		const parent = parents[index];
		const orphan = !tracks.get(parent)?.parents?.length;
		const handler = (parent as Partial<ChildChangeHandler>)[CHILD_RENDER_CHANGED];
		if (handler) handler.call(parent, component);
		else if (!orphan) renderChanged(parent);
		if (orphan) parents.splice(index, 1);
	}
}

/** The serial to pass to `isRenderStable` after rendering a child. */
export function renderSerial(): number {
	return serial;
}

/** End of a composite's render: `stable` says whether every child it drew is stable. */
export function settleRender(component: Component, stable: boolean): void {
	const track = renderTrack(component);
	track.composite = true;
	track.served = ++serial;
	track.volatile = !stable;
}

/**
 * Whether `component`, just rendered after `since` (a `renderSerial()`), returned rows that change only with a signal:
 * it is tracked, and a composite settled that render without a volatile child.
 */
export function isRenderStable(component: Component, since: number): boolean {
	if (!isRenderTracked(component)) return false;
	const track = tracks.get(component);
	if (!track?.composite) return true;
	return track.served > since && !track.volatile;
}
