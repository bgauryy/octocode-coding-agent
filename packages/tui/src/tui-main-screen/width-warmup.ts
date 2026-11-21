import type { Component } from "../tui/component.ts";
import { readChildren, rendersAsContainer } from "../tui/container-state.ts";
import { renderIsolated } from "../tui/render-isolation.ts";

/** Longest stretch one frame spends filling row caches at a new width before it yields to input and timers. */
const SLICE_MS = 16;
/**
 * Below this many leaves a width change lays out at once: the frame stays short, and a leaf that keeps no row cache
 * renders once, not twice.
 */
const MIN_LEAVES = 32;

/** The terminal's size now, and the size of the last frame the terminal shows (not positive: none to keep). */
export interface FrameSizeInput {
	resizePending: boolean;
	columns: number;
	rows: number;
	previousWidth: number;
	previousHeight: number;
}

export interface FrameSize {
	/** The size to paint at; undefined: paint nothing this frame. */
	size: { width: number; height: number } | undefined;
	/** Rows at the new width are still filling: another frame must follow. */
	warming: boolean;
}

interface Level {
	children: readonly Component[];
	index: number;
}

/**
 * Spreads a width change over frames. The frame at a new width renders every row of the transcript again, which for a
 * long transcript blocks input for longer than a frame. Before it, each frame renders the next leaves (the components
 * below plain containers, which pass their width on unchanged) at the new width for at most `SLICE_MS`, so their row
 * caches fill while frames keep the last width; the frame after the last slice lays out at the new width and mostly
 * reads caches. A tree of fewer than `MIN_LEAVES` leaves lays out at once. In a larger one a leaf that keeps no cache
 * renders twice, and one leaf is never split. Holds only a walk position: one entry per nesting level.
 */
export class WidthWarmup {
	/** The width of the last frame laid out; 0 before the first. */
	private laidOutWidth = 0;
	private target = 0;
	private readonly stack: Level[] = [];
	private finishNext = false;

	/** The next frame lays out at the terminal's width now, however long its leaves take (an explicit paint). */
	finishOnNextFrame(): void {
		this.finishNext = true;
	}

	/**
	 * The size of the next frame. While a resize waits for its settled frame, or leaves still fill at a new width, it is
	 * the size of the last frame: a width change replays the whole transcript, so a window drag replays once when it
	 * pauses, not at every frame the spinner or a stream asks. With no last frame to keep, nothing paints until then.
	 */
	next(root: Component, input: FrameSizeInput): FrameSize {
		const finish = this.finishNext;
		this.finishNext = false;
		const warming = !input.resizePending && !finish && !this.warm(root, input.columns);
		if (!input.resizePending && !warming) return this.layOut(input.columns, input.rows, false);
		if (input.previousWidth > 0 && input.previousHeight > 0) {
			return this.layOut(input.previousWidth, input.previousHeight, warming);
		}
		return warming ? { size: undefined, warming } : this.layOut(input.columns, input.rows, false);
	}

	private layOut(width: number, height: number, warming: boolean): FrameSize {
		if (!warming) {
			this.laidOutWidth = width;
			this.target = 0;
			this.stack.length = 0;
		}
		return { size: { width, height }, warming };
	}

	/**
	 * Render the next leaves at `width` for one slice. True when the frame may lay out at `width`: every leaf rendered
	 * at it in an earlier frame, or the tree is too small to warm. A frame that warmed does not also lay out.
	 */
	private warm(root: Component, width: number): boolean {
		if (this.laidOutWidth === 0 || width === this.laidOutWidth) return true;
		const stack = this.stack;
		if (this.target !== width) {
			this.target = width;
			stack.length = 0;
			const children = readChildren(root);
			if (children && hasLeaves(children, MIN_LEAVES)) stack.push({ children, index: 0 });
		}
		if (stack.length === 0) return true;
		const deadline = performance.now() + SLICE_MS;
		while (stack.length > 0) {
			const level = stack[stack.length - 1];
			const child = level.children[level.index++];
			if (child === undefined) {
				stack.pop();
				continue;
			}
			const nested = rendersAsContainer(child) ? readChildren(child) : undefined;
			if (nested) stack.push({ children: nested, index: 0 });
			else renderIsolated(child, width);
			if (performance.now() >= deadline) break;
		}
		return false;
	}
}

/** Whether the tree below `children` holds at least `count` leaves; visits at most that many leaves. */
function hasLeaves(children: readonly Component[], count: number): boolean {
	let left = count;
	const pending: (readonly Component[])[] = [children];
	for (let list = pending.pop(); list !== undefined; list = pending.pop()) {
		for (const child of list) {
			const nested = rendersAsContainer(child) ? readChildren(child) : undefined;
			if (nested) pending.push(nested);
			else if (--left === 0) return true;
		}
	}
	return false;
}
