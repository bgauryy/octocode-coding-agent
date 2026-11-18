/**
 * Shared utility for truncating text to visual lines (accounting for line wrapping).
 * Used by tool renderers and bash-execution.ts for consistent behavior.
 */

import type { Component } from "../tui.ts";
import { ELLIPSIS } from "../tokens/design.ts";
import { renderChanged, trackRenderChanges } from "../tui/render-signal.ts";
import { AnsiCodeTracker, updateTrackerFromText } from "../utils/ansi-tracker.ts";
import { truncateToWidth } from "../utils/truncate.ts";
import { visibleWidth } from "../utils/width.ts";
import { wrapTextWithAnsi } from "../utils/wrap.ts";
import { frameContentLines } from "../utils.ts";
import { Text } from "./text.ts";

/** How `wrapTextWithAnsi` splits text into logical lines. */
const LINE_BREAK = /\r\n|\r|\n/;

export interface VisualTruncateResult {
	visualLines: string[];
	/** Number of visual lines that were skipped (hidden) */
	skippedCount: number;
}

/**
 * Truncate text to a maximum number of visual lines.
 * This accounts for line wrapping based on terminal width.
 *
 * @param text - The text content (may contain newlines)
 * @param maxVisualLines - Maximum number of visual lines to show
 * @param width - Terminal/render width
 * @param paddingX - Horizontal padding for Text component (default 0).
 *                   Use 0 when result will be placed in a Box (Box adds its own padding).
 *                   Use 1 when result will be placed in a plain Container.
 * @param keep - Which visual lines to keep: the last ones (default) or the first ones.
 * @returns The truncated visual lines and count of skipped lines
 */
export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX: number = 0,
	keep: "start" | "end" = "end",
): VisualTruncateResult {
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}

	const logicalLines = text.split(LINE_BREAK);
	const limit = Math.max(0, Math.floor(maxVisualLines));
	if (logicalLines.length <= limit || text.trim() === "") {
		// Create a temporary Text component to render and get visual lines
		const allVisualLines = new Text(text, paddingX, 0).render(width);
		if (allVisualLines.length <= maxVisualLines) {
			return { visualLines: allVisualLines, skippedCount: 0 };
		}
		const truncatedLines =
			keep === "start" ? allVisualLines.slice(0, maxVisualLines) : allVisualLines.slice(-maxVisualLines);
		return { visualLines: truncatedLines, skippedCount: allVisualLines.length - maxVisualLines };
	}

	// A wrap never merges lines, so the kept visual lines come from at most `limit` logical lines: only those are
	// wrapped, and the rest are only counted. A 2 MB tool result used to be wrapped whole for a 5-line preview.
	const split = keep === "start" ? limit : logicalLines.length - limit;
	const kept = keep === "start" ? logicalLines.slice(0, split) : logicalLines.slice(split);
	const hidden = keep === "start" ? logicalLines.slice(split) : logicalLines.slice(0, split);
	const padding = Math.min(paddingX, Math.max(0, Math.floor((width - 1) / 2)));
	const contentWidth = Math.max(1, width - padding * 2);
	// Styles left open by earlier lines carry into later ones, as in a whole-text wrap, and can change where a line
	// breaks, so the tracker follows the lines in order: the hidden ones first when the end is kept.
	const tracker = new AnsiCodeTracker();
	let hiddenRows = 0;
	const countHidden = (first: boolean) => {
		for (const [index, line] of hidden.entries()) {
			hiddenRows += visualRowCount(line, contentWidth, () => (first && index === 0 ? "" : tracker.getActiveCodes()));
			updateTrackerFromText(line, tracker);
		}
	};
	if (keep === "end") countHidden(true);
	const prefix = keep === "end" ? tracker.getActiveCodes() : "";
	if (keep === "start") {
		for (const line of kept) updateTrackerFromText(line, tracker);
		countHidden(false);
	}
	const wrapped = wrapTextWithAnsi(`${prefix}${kept.join("\n")}`.replace(/\t/g, "   "), contentWidth);
	const visual = frameContentLines(wrapped, width, padding, 0);
	const visualLines = keep === "start" ? visual.slice(0, limit) : visual.slice(-limit);
	return { visualLines, skippedCount: hiddenRows + visual.length - visualLines.length };
}

/**
 * The rows `wrapTextWithAnsi` makes of one logical line after `prefix()` (the styles earlier lines left open), without
 * building them when the line fits.
 */
function visualRowCount(line: string, width: number, prefix: () => string): number {
	const normalized = line.includes("\t") ? line.replace(/\t/g, "   ") : line;
	// No UTF-16 code unit is wider than two cells, so a line this short fits whatever it holds.
	if (normalized.length * 2 <= width || visibleWidth(normalized) <= width) return 1;
	return wrapTextWithAnsi(prefix() + normalized, width).length;
}

interface VisualLinePreviewOptions {
	/** Styled text; may contain newlines. */
	text: string;
	maxVisualLines: number;
	/** Which visual lines to keep. The hint goes before kept end lines and after kept start lines. */
	keep: "start" | "end";
	/** Styled hint line for the given number of hidden visual lines. */
	formatHint: (hidden: number) => string;
}

/**
 * Collapsed tool output limited to a number of visual lines, like bash output. Limiting logical
 * lines instead lets a single long line (such as minified JSON) wrap across the whole screen.
 * Its text is fixed at construction, so its rows change only with the width or `invalidate`: it is render-tracked.
 */
export class VisualLinePreview implements Component {
	private options: VisualLinePreviewOptions;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(options: VisualLinePreviewOptions) {
		this.options = options;
	}

	render(width: number): string[] {
		if (this.cachedLines === undefined || this.cachedWidth !== width) {
			const { text, maxVisualLines, keep, formatHint } = this.options;
			const preview = truncateToVisualLines(text, maxVisualLines, width, 0, keep);
			const lines = preview.visualLines;
			if (preview.skippedCount > 0) {
				const hint = truncateToWidth(formatHint(preview.skippedCount), width, ELLIPSIS);
				this.cachedLines = keep === "start" ? [...lines, hint] : [hint, ...lines];
			} else {
				this.cachedLines = lines;
			}
			this.cachedWidth = width;
		}
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		renderChanged(this);
	}
}
trackRenderChanges(VisualLinePreview.prototype);
