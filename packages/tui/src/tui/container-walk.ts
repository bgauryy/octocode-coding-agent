/**
 * How a container joins its children's rows, and when it may skip children that did not change.
 *
 * A frame keeps each child's rows. The next render takes one of three paths:
 *
 * - quiet: same width, same children, no signal since, no volatile child: the last frame's rows, nothing walked;
 * - partial: same width and children: only the children that signalled and the volatile ones are rendered again;
 * - full: every child not known to be quiet is rendered, as every frame did before signals existed.
 *
 * A frame is never changed after it is made: parents, the layout recorder and the frame diff keep references to it.
 */

import type { Component } from "./component.ts";
import { activeLayoutRecorder, type LayoutRecorder, type NestedLayout, nestedLeafCount } from "./layout-recorder.ts";
import { renderFailed, renderIsolated, renderIsolatedWith } from "./render-isolation.ts";
import { isRowFrame, type RowFrame, type RowSource, rowCount, sharedRowsOf } from "./row-source.ts";
import {
	isRenderStable,
	linkRenderChild,
	renderSerial,
	renderTrack,
	settleRender,
	unlinkRenderChild,
} from "./render-signal.ts";
import {
	type ContainerFrame,
	type ContainerRenderState,
	containerChildren,
	rendersAsContainer,
	states,
} from "./container-state.ts";

let walkEpoch = 0;

/** Leading rows of `after` that are the same strings as in `before`, when the sources or `child` know it. */
function innerSharedRows(child: Component, before: RowSource, after: RowSource): number {
	const shared = sharedRowsOf(before, after);
	if (shared > 0 || isRowFrame(after) || isRowFrame(before)) return shared;
	// A container subclass hands over its own array, made from its frame's rows.
	const rows = states.get(child)?.frame?.rows;
	if (!rows || rows.lines !== after || rows.basis?.lines !== before) return 0;
	return Math.min(rows.sharedRows, before.length, after.length);
}

/** Rows up to which a child's new array is compared with its last one, so a redraw with the same rows keeps identity. */
const SAME_ROWS_LIMIT = 64;

/**
 * `lines`, or `before` when both hold the same rows: a component without a cache (a spinner between ticks, a status
 * line) returns a new array every frame, and keeping the old one spares every pass below a frame that changed nothing.
 */
function sameRowsAs(lines: RowSource, before: RowSource | undefined): RowSource {
	if (!before || lines === before || isRowFrame(lines) || isRowFrame(before)) return lines;
	if (lines.length !== before.length || lines.length > SAME_ROWS_LIMIT) return lines;
	for (let row = 0; row < lines.length; row++) if (lines[row] !== before[row]) return lines;
	return before;
}

function leafCountOf(nested: readonly NestedLayout[] | undefined): number {
	const count = nestedLeafCount(nested);
	return count > 0 ? count : 1;
}

/** A child's rows: a plain container's row frame (no array is made), any other component's array. */
function childRows(child: Component, width: number): RowSource {
	const state = states.get(child);
	if (!state || !rendersAsContainer(child)) return renderIsolated(child, width);
	return renderIsolatedWith(child, width, () => renderContainer(child, state, containerChildren(child), width).rows);
}

/** Render one child, recording what it renders when a recorder is active. */
function renderChild(
	child: Component,
	width: number,
	recorder: LayoutRecorder | undefined,
	start: number,
): { lines: RowSource; nested: readonly NestedLayout[] | undefined; stable: boolean } {
	const before = renderSerial();
	let lines: RowSource;
	let nested: readonly NestedLayout[] | undefined;
	if (recorder) {
		const base = recorder.base;
		recorder.beginChild(start);
		try {
			lines = childRows(child, width);
		} finally {
			nested = recorder.endChild();
			recorder.base = base;
		}
	} else lines = childRows(child, width);
	return { lines, nested, stable: isRenderStable(child, before) && !renderFailed(child) };
}

/** A new row frame replacing `previous` (no longer needed as a basis once replaced). */
function nextRows(
	previous: RowFrame | undefined,
	sources: RowSource[],
	offsets: number[],
	sharedRows: number,
): RowFrame {
	const basis = previous;
	if (basis) basis.basis = undefined;
	const total = offsets[offsets.length - 1];
	const shared = basis ? Math.min(sharedRows, total, basis.offsets[basis.offsets.length - 1]) : 0;
	return { sources, offsets, basis, sharedRows: shared, lines: undefined };
}

function fullWalk(
	owner: Component,
	last: ContainerFrame | undefined,
	previous: ContainerFrame | undefined,
	children: readonly Component[],
	dirty: Set<Component> | undefined,
	width: number,
	recorder: LayoutRecorder | undefined,
): ContainerFrame {
	const count = children.length;
	// Before any child renders (which may walk other containers): link the children, find duplicates, unlink the gone.
	const epoch = ++walkEpoch;
	let duplicates = false;
	for (const child of children) {
		const track = renderTrack(child);
		if (track.markEpoch === epoch) duplicates = true;
		track.markEpoch = epoch;
		linkRenderChild(owner, child);
	}
	if (last)
		for (const gone of last.components) if (renderTrack(gone).markEpoch !== epoch) unlinkRenderChild(owner, gone);

	const base = recorder?.base ?? 0;
	const sources: RowSource[] = [];
	const offsets: number[] = [];
	const nested: (readonly NestedLayout[] | undefined)[] | undefined = recorder ? [] : undefined;
	const unstable: number[] = [];
	let leafCount = 0;
	let firstChanged = -1;
	let keptRows = 0;
	let offset = 0;
	let next = 0;
	const sourcesBefore = previous?.rows.sources;
	for (let index = 0; index < count; index++) {
		const child = children[index];
		let lines: RowSource;
		let childNested: readonly NestedLayout[] | undefined;
		if (previous) while (next < previous.unstable.length && previous.unstable[next] < index) next++;
		const same = previous !== undefined && previous.components[index] === child;
		const quiet =
			same &&
			previous.unstable[next] !== index &&
			dirty?.has(child) !== true &&
			(!recorder || previous.nested?.[index] !== undefined);
		if (quiet && sourcesBefore) {
			lines = sourcesBefore[index];
			childNested = previous.nested?.[index];
		} else {
			const rendered = renderChild(child, width, recorder, base + offset);
			lines = sameRowsAs(rendered.lines, same ? sourcesBefore?.[index] : undefined);
			childNested = rendered.nested;
			if (!rendered.stable) unstable.push(index);
		}
		sources.push(lines);
		offsets.push(offset);
		if (nested) {
			nested.push(childNested);
			leafCount += leafCountOf(childNested);
		}
		if (firstChanged < 0 && (!same || sourcesBefore?.[index] !== lines)) {
			firstChanged = index;
			keptRows = offset;
		}
		offset += rowCount(lines);
	}
	offsets.push(offset);

	let rows: RowFrame;
	if (previous && firstChanged < 0 && previous.components.length === count) rows = previous.rows;
	else {
		if (firstChanged < 0) {
			// Only children removed from the end differ.
			firstChanged = count;
			keptRows = offset;
		}
		const sharedRows =
			previous === undefined
				? 0
				: keptRows +
					(firstChanged < count && previous.components[firstChanged] === children[firstChanged]
						? innerSharedRows(children[firstChanged], previous.rows.sources[firstChanged], sources[firstChanged])
						: 0);
		rows = nextRows(previous?.rows, sources, offsets, sharedRows);
	}
	return {
		width,
		components: children.slice(),
		rows,
		offsets: rows.offsets,
		nested,
		recorded: nested !== undefined,
		leafCount,
		unstable,
		duplicates,
	};
}

/** The children to render again: the volatile ones and those that signalled, ascending. */
function candidates(
	children: readonly Component[],
	previous: ContainerFrame,
	dirty: Set<Component> | undefined,
): number[] {
	const indices = previous.unstable.slice();
	if (dirty) {
		for (const child of dirty) {
			// A child that left is still linked until the next full walk unlinks it: nothing of it is drawn.
			const index = children.lastIndexOf(child);
			if (index !== -1) indices.push(index);
		}
	}
	if (indices.length > 1) {
		indices.sort((a, b) => a - b);
		let kept = 1;
		for (let index = 1; index < indices.length; index++) {
			if (indices[index] !== indices[kept - 1]) indices[kept++] = indices[index];
		}
		indices.length = kept;
	}
	return indices;
}

function partialWalk(
	owner: Component,
	previous: ContainerFrame,
	children: readonly Component[],
	dirty: Set<Component> | undefined,
	width: number,
	recorder: LayoutRecorder | undefined,
): ContainerFrame {
	const indices = candidates(children, previous, dirty);
	if (indices.length === 0) return previous;
	const base = recorder?.base ?? 0;
	const unstable: number[] = [];
	const before = previous.rows.sources;
	let sources: RowSource[] | undefined;
	// Rendered without a recorder, a child's nested layout is unknown until a recorded frame renders it again.
	let nested: (readonly NestedLayout[] | undefined)[] | undefined;
	let changedFrom = -1;
	let resizedFrom = -1;
	let delta = 0;
	for (const index of indices) {
		const child = children[index];
		// A child that signalled while this container had no parent was unlinked: link it again.
		linkRenderChild(owner, child);
		const rendered = renderChild(child, width, recorder, base + previous.offsets[index] + delta);
		if (!rendered.stable) unstable.push(index);
		const lines = sameRowsAs(rendered.lines, before[index]);
		if (lines !== before[index]) {
			if (changedFrom < 0) changedFrom = index;
			sources ??= before.slice();
			sources[index] = lines;
		}
		if (previous.nested && previous.nested[index] !== rendered.nested) {
			nested ??= previous.nested.slice();
			nested[index] = rendered.nested;
		}
		const change = rowCount(lines) - rowCount(before[index]);
		if (change !== 0 && resizedFrom < 0) resizedFrom = index;
		delta += change;
	}
	let leafCount = previous.leafCount;
	if (nested && previous.nested) {
		for (const index of indices) leafCount += leafCountOf(nested[index]) - leafCountOf(previous.nested[index]);
	}
	const layout = {
		nested: nested ?? previous.nested,
		recorded: recorder !== undefined && previous.recorded,
		leafCount,
		unstable,
	};
	// The same rows: parents keep the row frame, only what is known about the children changed.
	if (!sources) return { ...previous, ...layout };

	let offsets = previous.offsets as number[];
	if (resizedFrom >= 0) {
		offsets = previous.offsets.slice();
		for (let index = resizedFrom + 1; index < offsets.length; index++)
			offsets[index] = offsets[index - 1] + rowCount(sources[index - 1]);
	}
	const keptRows = previous.offsets[changedFrom];
	const sharedRows = keptRows + innerSharedRows(children[changedFrom], before[changedFrom], sources[changedFrom]);
	const rows = nextRows(previous.rows, sources, offsets, sharedRows);
	return { ...layout, width, components: previous.components, rows, offsets, duplicates: false };
}

/** `Container.render`: the children's rows, skipping the children that are known not to have changed. */
export function renderContainer(
	owner: Component,
	state: ContainerRenderState,
	children: readonly Component[],
	width: number,
): ContainerFrame {
	const recorder = activeLayoutRecorder();
	const last = state.frame;
	const previous = last?.width === width ? last : undefined;
	const sameChildren =
		previous !== undefined &&
		!state.structureChanged &&
		previous.components.length === children.length &&
		(!recorder || previous.recorded);
	if (sameChildren && !state.signaled && previous.unstable.length === 0) {
		recorder?.attach(previous);
		settleRender(owner, true);
		state.paint(previous);
		return previous;
	}
	const dirty = state.dirty;
	state.dirty = undefined;
	state.signaled = false;
	const structureChanged = state.structureChanged;
	state.structureChanged = false;
	let frame: ContainerFrame;
	try {
		frame =
			sameChildren && !previous.duplicates
				? partialWalk(owner, previous, children, dirty, width, recorder)
				: fullWalk(owner, last, previous, children, dirty, width, recorder);
	} catch (error) {
		// A child threw outside a frame's render isolation: forget the frame, so nothing is skipped on the next render.
		state.frame = undefined;
		state.structureChanged ||= structureChanged;
		throw error;
	}
	state.frame = frame;
	recorder?.attach(frame);
	settleRender(owner, frame.unstable.length === 0);
	state.paint(frame);
	return frame;
}

/** A plain container's rows as a row frame, without joining them; undefined for any other component. */
export function renderRowFrame(component: Component, width: number): RowFrame | undefined {
	const state = states.get(component);
	if (!state || !rendersAsContainer(component)) return undefined;
	return renderContainer(component, state, containerChildren(component), width).rows;
}
