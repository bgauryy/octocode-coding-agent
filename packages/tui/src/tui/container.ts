import { type Component, dispatchMouseEvent, type TuiMouseDispatchResult, type TuiMouseEvent } from "./component.ts";
import { activeLayoutRecorder } from "./layout-recorder.ts";
import { renderIsolated } from "./render-isolation.ts";

/** One painted frame of a container: its children, the array each returned, and their concatenation. */
interface ContainerFrame {
	width: number;
	components: Component[];
	arrays: string[][];
	lines: string[];
}

/** Rows below which a row-by-row append beats an array copy; above it `concat` copies in bulk. */
const BULK_ROWS = 1024;
/** Arrays passed to one `concat` call, far below the engine's argument limit. */
const CONCAT_BATCH = 4096;

/** Append the rows of `arrays[from..]` (`rows` in total) to `head`, returning the result. */
function appendRows(head: string[], arrays: string[][], from: number, rows: number): string[] {
	if (rows < BULK_ROWS) {
		for (let i = from; i < arrays.length; i++) {
			const childLines = arrays[i];
			for (let row = 0; row < childLines.length; row++) head.push(childLines[row]);
		}
		return head;
	}
	let lines = head;
	for (let start = from; start < arrays.length; start += CONCAT_BATCH) {
		lines = lines.concat(...arrays.slice(start, start + CONCAT_BATCH));
	}
	return lines;
}

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
	children: Component[] = [];
	private renderCache?: ContainerFrame;
	/** The last painted frame; it outlives `invalidate` so a click lands where the rows were drawn. */
	private mouseLayout?: ContainerFrame;

	addChild(component: Component): void {
		this.children.push(component);
	}

	removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index !== -1) {
			this.children.splice(index, 1);
		}
	}

	clear(): void {
		this.children = [];
	}

	/**
	 * Drop this container's own copy of its children's rows, keeping theirs: a frame that draws the children one by one
	 * (a virtualized scroll view) never reads it, and it would hold a second array of every row in the transcript.
	 */
	releaseRenderCache(): void {
		this.renderCache = undefined;
		this.mouseLayout = undefined;
	}

	invalidate(): void {
		this.renderCache = undefined;
		for (const child of this.children) {
			child.invalidate?.();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (event.y < 0 || event.y >= event.height) return undefined;
		const painted = this.mouseLayout?.width === event.width ? this.mouseLayout : undefined;
		const components = painted?.components ?? this.children;
		let childY = 0;
		for (let i = 0; i < components.length; i++) {
			const child = components[i];
			const childHeight = painted ? painted.arrays[i].length : child.render(event.width).length;
			if (event.y >= childY && event.y < childY + childHeight) {
				// Keep the last painted positions until redraw, but never activate a detached child.
				if (!this.children.includes(child)) return undefined;
				const result = dispatchMouseEvent(child, {
					...event,
					y: event.y - childY,
					height: childHeight,
				});
				if (result?.focus && (this as Component).handleInput) return { ...result, focusTarget: this };
				return result;
			}
			childY += childHeight;
		}
		return undefined;
	}

	/**
	 * Concatenate the children's rows. When the width and every child's returned array are the same
	 * references as last frame, the previous result is returned, so parents and the frame diff can
	 * rely on identity. A child that returns a new array makes a new result: the rows of the children
	 * before the first changed one are copied from the previous result in one slice and the rest are
	 * appended in bulk, so a changed tail costs array copies, not a row-by-row walk through every child.
	 * Results are never mutated after they are returned.
	 */
	render(width: number): string[] {
		const previous = this.renderCache?.width === width ? this.renderCache : undefined;
		const children = this.children;
		const count = children.length;
		const layout = activeLayoutRecorder();
		const base = layout?.base ?? 0;
		// Allocated at the first child that differs from the previous frame; until then the arrays are the previous ones.
		let arrays: string[][] | undefined = previous ? undefined : [];
		let firstChanged = previous ? -1 : 0;
		let keptRows = 0;
		let offset = 0;
		for (let i = 0; i < count; i++) {
			const child = children[i];
			const leavesBefore = layout?.leaves.length ?? 0;
			if (layout) {
				layout.base = base + offset;
				layout.starts.set(child, base + offset);
			}
			const childLines = renderIsolated(child, width);
			// A child that reported no leaf of its own is a leaf itself.
			if (layout) {
				if (layout.leaves.length === leavesBefore)
					layout.leaves.push({ component: child, start: base + offset, length: childLines.length });
				layout.base = base;
			}
			if (arrays) arrays.push(childLines);
			else if (previous && (previous.components[i] !== child || previous.arrays[i] !== childLines)) {
				firstChanged = i;
				keptRows = offset;
				arrays = previous.arrays.slice(0, i);
				arrays.push(childLines);
			}
			offset += childLines.length;
		}
		if (!arrays && previous) {
			// Every child is unchanged; only children removed from the end can differ.
			if (previous.components.length === count) return previous.lines;
			firstChanged = count;
			keptRows = offset;
			arrays = previous.arrays.slice(0, count);
		}
		const kept = arrays ?? [];
		const head = previous && keptRows > 0 ? previous.lines.slice(0, keptRows) : [];
		const lines = appendRows(head, kept, Math.max(0, firstChanged), offset - keptRows);
		const frame: ContainerFrame = { width, components: children.slice(), arrays: kept, lines };
		this.renderCache = frame;
		this.mouseLayout = frame;
		return lines;
	}
}
