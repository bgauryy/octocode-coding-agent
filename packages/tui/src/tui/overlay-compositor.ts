import { sliceByColumn } from "../utils/columns.ts";
import { visibleWidth } from "../utils/width.ts";
import { dispatchMouseEvent, type TuiMouseDispatchResult, type TuiMouseEvent } from "./component.ts";
import { compositeTuiLine } from "./composite.ts";
import type { FocusManager } from "./focus-manager.ts";
import { resolveOverlayLayout } from "./overlay-layout.ts";
import type { OverlayStackEntry, RenderedOverlayLayout } from "./overlay-types.ts";
import { renderIsolated } from "./render-isolation.ts";

/** Paints the focus manager's overlays onto content lines and remembers where each landed. */
export class OverlayCompositor {
	private readonly focus: FocusManager;
	private renderedLayouts: RenderedOverlayLayout[] = [];

	constructor(focus: FocusManager) {
		this.focus = focus;
	}

	/** Dispatch to the visually topmost overlay under the pointer. */
	dispatchMouse(event: TuiMouseEvent): { hit: boolean; result?: TuiMouseDispatchResult } {
		for (let index = this.renderedLayouts.length - 1; index >= 0; index--) {
			const layout = this.renderedLayouts[index];
			if (
				event.screenX < layout.col ||
				event.screenX >= layout.col + layout.width ||
				event.screenY < layout.row ||
				event.screenY >= layout.row + layout.height
			) {
				continue;
			}
			const result = dispatchMouseEvent(layout.entry.component, {
				...event,
				x: event.screenX - layout.col,
				y: event.screenY - layout.row,
				width: layout.width,
				height: layout.height,
			});
			return result
				? {
						hit: true,
						result: result.focus ? { ...result, focusTarget: layout.entry.component } : result,
					}
				: { hit: true };
		}
		return { hit: false };
	}

	/** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
	composite(
		lines: string[],
		termWidth: number,
		termHeight: number,
		resolveFakeCursors: (lines: string[]) => string[],
	): string[] {
		const stack = this.focus.stack;
		if (stack.length === 0) {
			this.renderedLayouts = [];
			return lines;
		}
		const result = [...lines];

		for (const entry of stack) entry.bounds = undefined;

		// Pre-render all visible overlays and calculate positions
		const rendered: { entry: OverlayStackEntry; overlayLines: string[]; row: number; col: number; w: number }[] = [];
		let minLinesNeeded = result.length;

		const visibleEntries = stack.filter((e) => this.focus.isOverlayVisible(e));
		visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
		for (const entry of visibleEntries) {
			const { component, options } = entry;

			// Get layout with height=0 first to determine width and maxHeight
			// (width and maxHeight don't depend on overlay height)
			const { width, maxHeight } = resolveOverlayLayout(options, 0, termWidth, termHeight);

			// Render component at calculated width
			let overlayLines = resolveFakeCursors(renderIsolated(component, width));

			// Apply maxHeight if specified
			if (maxHeight !== undefined && overlayLines.length > maxHeight) {
				overlayLines = overlayLines.slice(0, maxHeight);
			}

			// Get final row/col with actual overlay height
			const { row, col } = resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);
			entry.bounds = { row, col, width, height: overlayLines.length };

			rendered.push({ entry, overlayLines, row, col, w: width });
			minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
		}
		this.renderedLayouts = rendered.map(({ entry, row, col, w, overlayLines }) => ({
			entry,
			row,
			col,
			width: w,
			height: overlayLines.length,
		}));

		// Pad to at least terminal height so overlays have screen-relative positions.
		// Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing
		// inflation that pushed content into scrollback on terminal widen.
		const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);

		// Extend result with empty lines if content is too short for overlay placement or working area
		while (result.length < workingHeight) {
			result.push("");
		}

		const viewportStart = Math.max(0, workingHeight - termHeight);

		// Composite each overlay
		for (const { overlayLines, row, col, w } of rendered) {
			for (let i = 0; i < overlayLines.length; i++) {
				const idx = viewportStart + row + i;
				if (idx >= 0 && idx < result.length) {
					// Defensive: truncate overlay line to declared width before compositing
					// (components should already respect width, but this ensures it)
					const truncatedOverlayLine =
						visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
					result[idx] = compositeTuiLine(result[idx], truncatedOverlayLine, col, w, termWidth);
				}
			}
		}

		return result;
	}
}
