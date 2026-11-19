/**
 * What a virtualized scroll view keeps between frames: its items (the leaves of plain containers), each item's height
 * at the current width, and the items whose height is still an estimate.
 *
 * A frame renders the rows in view and measures a few unmeasured items; the rest are measured between frames, in short
 * slices that yield to input. An item is measured once per width: it is rendered again only after it signals a change
 * (it is tracked, see `render-signal.ts`), or every frame when it cannot be trusted to signal (untracked or volatile).
 * Anything doubtful (an item listed twice, an unknown component) makes the scroll view use its exact layout instead.
 */

import type { Component } from "../tui/component.ts";
import { Container } from "../tui/container.ts";
import { containerStructureVersion, paintedChildren, readChildren, signalledChildren } from "../tui/container-state.ts";
import { bindRenderIsolation, renderFailed, renderIsolated } from "../tui/render-isolation.ts";
import {
	CHILD_RENDER_CHANGED,
	isRenderStable,
	linkRenderChild,
	unlinkRenderChild,
	renderSerial,
} from "../tui/render-signal.ts";
import { RowHeights } from "./row-heights.ts";

/** Time one measuring slice between frames may take before it yields. */
const SLICE_MS = 8;

/** The scroll position a slice keeps: content above the rows in view moves them by `shiftContent`. */
export interface VirtualScrollState {
	readonly scrollTop: number;
	readonly isFollowingEnd?: boolean;
	readonly isScrollbarVisible?: boolean;
	shiftContent?(rows: number): void;
}

interface Measure {
	width: number;
	height: number;
	/** Measured at `width` and no signal since. */
	clean: boolean;
	/** Its rows may change without a signal: rendered every frame. */
	unstable: boolean;
}

/** A plain `Container` renders exactly its children's rows in order, so the document is the leaves of plain containers. */
function documentItems(component: Component, items: Component[], containers: Container[]): void {
	if (
		component instanceof Container &&
		Object.getPrototypeOf(component) === Container.prototype &&
		component.render === Container.prototype.render
	) {
		containers.push(component);
		// Read without counting as an edit: an edit would make the containers walk every child on their next frame.
		for (const child of readChildren(component) ?? component.children) documentItems(child, items, containers);
	} else items.push(component);
}

function sameItems(a: readonly Component[], b: readonly Component[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
	return true;
}

export class VirtualDocument {
	/** Draws like the document and takes no mouse events, which go to the items. */
	readonly view: Component;
	/** Width at which every item was measured and the exact layout took over; the virtual path is off at it. */
	exactWidth: number | undefined;
	/** The table describes the screen: the last frame of this view was virtual, at `width`. */
	tableCurrent = false;
	width = 0;
	items: Component[] = [];
	containers: Container[] = [];
	heights: number[] = [];
	total = 0;
	pendingCount = 0;
	/** The content height the scroll view was last told: the table's total less what grew below the rows in view since. */
	reported = 0;
	/** An item is listed twice: rows cannot be told apart by item, so the exact layout is used. */
	duplicates = false;
	private index = new Map<Component, number>();
	/** 1 while the item's height is an estimate (or a measure taken before its last signal). */
	private pendingFlags = new Uint8Array(0);
	private unstableFlags = new Uint8Array(0);
	private unstable: number[] = [];
	/** Items to measure, the next one last. */
	private pending: number[] = [];
	private readonly rows = new RowHeights();
	private nearby: number[] = [];
	private previousFirst = 0;
	private readonly known = new WeakMap<Component, Measure>();
	/** Items that signalled since they were measured; heard through `listener`, a parent each item is linked to. */
	private readonly dirty = new Set<Component>();
	private readonly listener: Component;
	private slice: (() => void) | undefined;
	/** Structure version and each container's child count when the items were listed. */
	private listVersion = -1;
	private listLengths: number[] = [];
	private sliceScheduled: NodeJS.Immediate | undefined;

	constructor(view: Component) {
		this.view = view;
		const dirty = this.dirty;
		this.listener = {
			render: () => [],
			invalidate() {},
			[CHILD_RENDER_CHANGED]: (child: Component) => dirty.add(child),
		} as Component;
	}

	/** Release subscriptions even when exact layout has taken over. A later mount gets a fresh document. */
	dispose(): void {
		this.cancelSlices();
		for (const item of this.items) unlinkRenderChild(this.listener, item);
		this.dirty.clear();
	}

	/**
	 * Bring the table to `root`'s items at `width`. Entering from an exact frame, heights the containers last painted
	 * are the estimates, so the scroll position still points at the rows it showed. False when the document cannot be
	 * virtualized.
	 */
	prepare(root: Component, width: number): boolean {
		const unchanged = this.listUnchanged();
		const items: Component[] = unchanged ? this.items : [];
		const containers: Container[] = unchanged ? this.containers : [];
		if (!unchanged) documentItems(root, items, containers);
		let painted: Map<Component, number> | undefined;
		if (!this.tableCurrent) {
			painted = new Map();
			for (const container of containers) {
				const layout = paintedChildren(container);
				if (layout) {
					const { components, offsets } = layout;
					for (let index = 0; index < components.length; index++)
						painted.set(components[index], offsets[index + 1] - offsets[index]);
				}
				// Signals the containers heard while they laid out every frame: those items changed since they were drawn.
				for (const child of signalledChildren(container) ?? []) this.forget(child);
			}
		}
		for (const child of this.dirty) this.forget(child);
		if (!this.tableCurrent || width !== this.width || !sameItems(items, this.items))
			this.rebuild(items, width, painted);
		this.containers = containers;
		this.listVersion = containerStructureVersion();
		this.listLengths = containers.map((container) => readChildren(container)?.length ?? -1);
		this.absorbDirty();
		this.tableCurrent = true;
		return !this.duplicates && this.items.length > 0;
	}

	/**
	 * No children list in the document was edited since the items were listed: every edit (and every read through
	 * `children`, which may be followed by an edit in place) moves the structure version, and a list that changed length
	 * is caught too. Anything else lists the items again.
	 */
	private listUnchanged(): boolean {
		if (this.listVersion !== containerStructureVersion() || this.listLengths.length !== this.containers.length)
			return false;
		for (let index = 0; index < this.containers.length; index++)
			if ((readChildren(this.containers[index])?.length ?? -1) !== this.listLengths[index]) return false;
		return true;
	}

	/** An item changed: its measure no longer holds. */
	private forget(component: Component): void {
		const known = this.known.get(component);
		if (known) known.clean = false;
	}

	/** Items that signalled since they were measured are measured again, first. */
	private absorbDirty(): void {
		for (const component of this.dirty) {
			const index = this.index.get(component);
			if (index !== undefined && this.pendingFlags[index] === 0) {
				this.pendingFlags[index] = 1;
				this.pendingCount++;
				this.pending.push(index);
			}
		}
		this.dirty.clear();
	}

	private rebuild(items: Component[], width: number, painted: ReadonlyMap<Component, number> | undefined): void {
		const previous = new Map<Component, number>();
		if (this.tableCurrent)
			for (let index = 0; index < this.items.length; index++) previous.set(this.items[index], this.heights[index]);
		const retained = new Set(items);
		for (const item of this.items) {
			if (retained.has(item)) continue;
			unlinkRenderChild(this.listener, item);
			this.forget(item);
		}
		this.items = items;
		this.width = width;
		this.index = new Map();
		this.heights = Array.from({ length: items.length }, () => 0);
		this.pendingFlags = new Uint8Array(items.length);
		this.unstableFlags = new Uint8Array(items.length);
		this.unstable = [];
		this.pending = [];
		this.nearby = [];
		this.pendingCount = 0;
		this.total = 0;
		for (let index = 0; index < items.length; index++) {
			const item = items[index];
			this.index.set(item, index);
			const known = this.known.get(item);
			let height: number;
			if (known?.clean && known.width === width) {
				height = known.height;
				if (known.unstable) {
					this.unstableFlags[index] = 1;
					this.unstable.push(index);
				}
			} else {
				height = previous.get(item) ?? painted?.get(item) ?? known?.height ?? 1;
				this.pendingFlags[index] = 1;
				this.pendingCount++;
				this.pending.push(index);
			}
			this.heights[index] = height;
			this.total += height;
		}
		this.duplicates = this.index.size !== items.length;
		this.rows.reset(this.heights);
	}

	/** Render item `index` at the table's width: its rows, and how much taller it got than the table said. */
	measure(index: number): { lines: string[]; delta: number } {
		const item = this.items[index];
		// Linked first, so a change the item signals while rendering is heard too.
		linkRenderChild(this.listener, item);
		const before = renderSerial();
		const lines = renderIsolated(item, this.width);
		const unstable = !isRenderStable(item, before) || renderFailed(item);
		const delta = lines.length - this.heights[index];
		this.heights[index] = lines.length;
		this.rows.add(index, delta);
		this.total += delta;
		if (this.pendingFlags[index] === 1) {
			this.pendingFlags[index] = 0;
			this.pendingCount--;
		}
		if (unstable && this.unstableFlags[index] === 0) this.unstable.push(index);
		this.unstableFlags[index] = unstable ? 1 : 0;
		const known = this.known.get(item);
		if (known) {
			known.width = this.width;
			known.height = lines.length;
			known.clean = true;
			known.unstable = unstable;
		} else this.known.set(item, { width: this.width, height: lines.length, clean: true, unstable });
		return { lines, delta };
	}

	isPending(index: number): boolean {
		return this.pendingFlags[index] === 1;
	}

	/** Render again every item whose rows may change without a signal; returns the growth of those above `top`. */
	measureUnstable(top: number): number {
		let shift = 0;
		let kept = 0;
		for (const index of this.unstable) {
			if (this.unstableFlags[index] === 0) continue;
			const { delta } = this.measure(index);
			if (index < top) shift += delta;
			if (this.unstableFlags[index] === 1) this.unstable[kept++] = index;
		}
		this.unstable.length = kept;
		return shift;
	}

	/** Prefer one viewport ahead of the scroll direction, then half a viewport behind it, within the same time budget. */
	prioritize(first: number, last: number, viewportRows: number): void {
		const forward = first >= this.previousFirst;
		this.previousFirst = first;
		const nearby: number[] = [];
		const collect = (start: number, step: number, rows: number) => {
			let remaining = rows;
			// Bound scanning too: hidden rows or a badly underestimated long item cannot inflate this work.
			for (
				let at = start, count = 0;
				at >= 0 && at < this.items.length && remaining > 0 && count < 32;
				count++, at += step
			) {
				if (this.pendingFlags[at] === 1) nearby.push(at);
				remaining -= Math.max(1, this.heights[at]);
			}
		};
		collect(forward ? last + 1 : first - 1, forward ? 1 : -1, viewportRows);
		collect(forward ? first - 1 : last + 1, forward ? -1 : 1, Math.ceil(viewportRows / 2));
		this.nearby = nearby.reverse();
	}

	/** Measure nearby pending items, then the remaining backlog, until `deadline`; return growth above `top`. */
	measurePending(top: number, deadline: number, atLeast = 0): number {
		let shift = 0;
		let measured = 0;
		while (this.pendingCount > 0 && (measured < atLeast || performance.now() < deadline)) {
			const index = this.nearby.pop() ?? this.pending.pop();
			if (index === undefined) break;
			if (this.pendingFlags[index] === 0) continue;
			const { delta } = this.measure(index);
			if (index < top) shift += delta;
			measured++;
		}
		return shift;
	}

	/** The item holding content row `row`, and the row within it; the end of the document past its last row. */
	locate(row: number): { index: number; offset: number; top: number } {
		return this.rows.locate(row);
	}

	/** The row at the top of item `index`, with the item's height as the table has it. */
	rowOf(index: number, offset: number): number {
		const height = this.heights[index] ?? 0;
		return this.rows.before(index) + Math.min(offset, Math.max(0, height - 1));
	}

	/** Whether the items are still the ones in the table. */
	matches(root: Component): boolean {
		if (this.listUnchanged()) return true;
		const items: Component[] = [];
		documentItems(root, items, []);
		return sameItems(items, this.items);
	}

	/**
	 * Keep measuring between frames, in slices that yield to input, until every item is measured; then ask for the
	 * frame that lays the document out exactly. Bound to the frame's render isolation; a failure leaves the rest to
	 * the frames.
	 */
	scheduleSlices(root: Component, state: VirtualScrollState, requestRender: () => void): void {
		if (this.pendingCount === 0) return;
		this.slice = bindRenderIsolation(() => this.runSlice(root, state, requestRender));
		if (this.sliceScheduled) return;
		this.sliceScheduled = setImmediate(() => {
			this.sliceScheduled = undefined;
			const slice = this.slice;
			this.slice = undefined;
			try {
				slice?.();
			} catch {
				// Frames measure what is left.
			}
		});
	}

	cancelSlices(): void {
		if (this.sliceScheduled) clearImmediate(this.sliceScheduled);
		this.sliceScheduled = undefined;
		this.slice = undefined;
	}

	private runSlice(root: Component, state: VirtualScrollState, requestRender: () => void): void {
		if (!this.tableCurrent || this.pendingCount === 0 || !this.matches(root)) return;
		const top = this.locate(state.scrollTop).index;
		const totalBefore = this.total;
		const shift = this.measurePending(top, performance.now() + SLICE_MS, 1);
		this.shift(state, shift);
		// The scrollbar and the rows-below indicator show the content height: repaint when they may have moved.
		const visible = state.isScrollbarVisible === true || state.isFollowingEnd !== true;
		if (this.pendingCount === 0 || (visible && this.total !== totalBefore)) requestRender();
		if (this.pendingCount > 0) this.scheduleSlices(root, state, requestRender);
	}

	/** Move the rows in view by `rows` (content above them changed height). */
	shift(state: VirtualScrollState, rows: number): void {
		if (rows === 0) return;
		this.reported += rows;
		state.shiftContent?.(rows);
	}

	/** Items the containers in the document heard signals from since their last frame. */
	signalledCount(): number {
		let count = 0;
		for (const container of this.containers) count += signalledChildren(container)?.size ?? 0;
		return count;
	}
}
