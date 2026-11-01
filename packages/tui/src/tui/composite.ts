import { isImageLine } from "../terminal-image.ts";
import { extractSegments, sliceByColumn, sliceWithWidth } from "../utils/columns.ts";
import { visibleWidth } from "../utils/width.ts";
import { normalizeTerminalOutput } from "../utils.ts";

const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";

/** Composite overlay content into a terminal line at a fixed column. */
export function compositeTuiLine(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	if (isImageLine(baseLine)) return baseLine;

	const afterStart = startCol + overlayWidth;
	const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
	const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);
	const result =
		base.before +
		" ".repeat(beforePad) +
		SEGMENT_RESET +
		overlay.text +
		" ".repeat(overlayPad) +
		SEGMENT_RESET +
		base.after +
		" ".repeat(afterPad);

	return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
}

/** Normalize each non-image line and end it with a style and hyperlink reset, in place. */
export function applyLineResets(lines: string[]): string[] {
	const reset = SEGMENT_RESET;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!isImageLine(line)) {
			lines[i] = normalizeTerminalOutput(line) + reset;
		}
	}
	return lines;
}
