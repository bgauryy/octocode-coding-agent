/**
 * Cursor markers: the zero-width APC sequences components emit so the renderer can place the
 * hardware cursor (for IME candidate windows) and draw fake cursors.
 */

import { stripRowMarks } from "../utils/row-marks.ts";
import { visibleWidth } from "../utils/width.ts";

/** APC string terminator (ST, ESC \). APC ends with ST; BEL ends only OSC, and a terminal may swallow the rest of the row after it. */
const ST = "\x1b\\";

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = `\x1b_octo:c${ST}`;

/** Fake cursor markers - zero-width APC sequences around the text drawn as the cursor. See resolveFakeCursors(). */
export const FAKE_CURSOR_START = `\x1b_octo:fc${ST}`;
const FAKE_CURSOR_END = `\x1b_octo:/fc${ST}`;
// CURSOR_MARKER + FAKE_CURSOR_START + text + FAKE_CURSOR_END. Truncating the line right after the cursor cell drops the end.
const FOCUSED_FAKE_CURSOR = /(\x1b_octo:c\x1b\\)\x1b_octo:fc\x1b\\(.*?)(?:\x1b_octo:\/fc\x1b\\|$)/s;

export function renderFakeCursor(text: string): string {
	return `${FAKE_CURSOR_START}${text}${FAKE_CURSOR_END}`;
}

/**
 * Find and extract cursor position from rendered lines.
 * Strips every CURSOR_MARKER from every row, so none reaches the terminal, and reports the position of
 * the bottom-most one in the bottom terminal height lines (visible viewport).
 * @param lines - Rendered lines; changed in place
 * @param height - Terminal height (visible viewport size)
 * @returns Cursor position { row, col } or null if no marker is in the viewport
 */
export function extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
	const viewportTop = Math.max(0, lines.length - height);
	let position: { row: number; col: number } | null = null;
	for (let row = lines.length - 1; row >= 0; row--) {
		const line = lines[row];
		const markerIndex = line.indexOf(CURSOR_MARKER);
		if (markerIndex === -1) continue;
		if (position === null && row >= viewportTop) {
			// Calculate visual column (width of text before marker)
			position = { row, col: visibleWidth(line.slice(0, markerIndex)) };
		}
		lines[row] = line.replaceAll(CURSOR_MARKER, "");
	}
	return position;
}

/**
 * Resolve fake cursor markers to reverse video. When the hardware cursor is shown, a fake cursor
 * directly after CURSOR_MARKER is dropped because the terminal cursor is drawn there. Fake cursors
 * of components without focus have no CURSOR_MARKER and stay visible. Row marks (`row-marks.ts`) are dropped: they
 * tell search what a row is and must not reach the terminal.
 */
export function resolveFakeCursors(lines: string[], showHardwareCursor: boolean): string[] {
	return lines.map((marked) => {
		if (!marked.includes("\x1b_octo:")) return marked;
		const line = stripRowMarks(marked);
		if (!line.includes(FAKE_CURSOR_START)) return line;
		const resolved = showHardwareCursor ? line.replace(FOCUSED_FAKE_CURSOR, "$1$2") : line;
		return resolved.replaceAll(FAKE_CURSOR_START, "\x1b[7m").replaceAll(FAKE_CURSOR_END, "\x1b[27m");
	});
}
