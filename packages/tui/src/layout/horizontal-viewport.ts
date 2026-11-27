import { closeOpenStyles } from "../utils/ansi-tracker.ts";
import { sliceByColumn } from "../utils/columns.ts";
import { truncateToWidth } from "../utils/truncate.ts";

export interface HorizontalViewportRow {
	gutter: string;
	body: string;
	anchorCol: number;
	bodyWidth: number;
	isSelected: boolean;
}

const TREE_GUTTER_WIDTH = 2;
const MIN_VISIBLE_ANCHOR_CONTENT_WIDTH = 4;
const MAX_VISIBLE_ANCHOR_CONTENT_WIDTH = 20;
const MIN_ANCHOR_CONTEXT_WIDTH = 2;
const MAX_ANCHOR_CONTEXT_WIDTH = 12;

/**
 * Render tree rows into a horizontally clipped viewport.
 *
 * The tree gutter is always kept visible. The row bodies are shifted left only
 * when the selected row's anchor (the start of its entry text after tree
 * indentation/markers) would otherwise be too far right to see useful content.
 */
export function renderHorizontalViewport(rows: HorizontalViewportRow[], width: number): string[] {
	const viewportWidth = Math.max(0, width - TREE_GUTTER_WIDTH);
	const maxBodyWidth = rows.reduce((max, row) => Math.max(max, row.bodyWidth), 0);
	const maxHorizontalScroll = Math.max(0, maxBodyWidth - viewportWidth);
	const selectedRow = rows.find((row) => row.isSelected);

	// Only pan horizontally when needed to keep enough selected-row content visible after its anchor.
	let horizontalScroll = 0;
	if (selectedRow && maxHorizontalScroll > 0) {
		const minVisibleAnchorContentWidth = Math.min(
			MAX_VISIBLE_ANCHOR_CONTENT_WIDTH,
			Math.max(MIN_VISIBLE_ANCHOR_CONTENT_WIDTH, Math.floor(viewportWidth / 3)),
		);
		if (selectedRow.anchorCol > viewportWidth - minVisibleAnchorContentWidth) {
			const anchorContextWidth = Math.min(
				MAX_ANCHOR_CONTEXT_WIDTH,
				Math.max(MIN_ANCHOR_CONTEXT_WIDTH, Math.floor(viewportWidth / 4)),
			);
			horizontalScroll = Math.min(maxHorizontalScroll, selectedRow.anchorCol - anchorContextWidth);
		}
	}

	// Clip only the body; the fixed-width gutter remains visible as navigation context.
	return rows.map((row) => {
		if (horizontalScroll === 0) return truncateToWidth(row.gutter + row.body, width, "");
		// The clip can cut a style's closer off; close only what is left open, not a full reset.
		const body = sliceByColumn(row.body, horizontalScroll, viewportWidth, true);
		return truncateToWidth(`${row.gutter}${body}${closeOpenStyles(body)}`, width, "");
	});
}
