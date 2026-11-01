/**
 * Cursor markers: the zero-width APC sequences components emit so the renderer can place the
 * hardware cursor (for IME candidate windows) and draw fake cursors.
 */

import { visibleWidth } from "../utils/width.ts";

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_octo:c\x07";

/** Fake cursor markers - zero-width APC sequences around the text drawn as the cursor. See resolveFakeCursors(). */
export const FAKE_CURSOR_START = "\x1b_octo:fc\x07";
const FAKE_CURSOR_END = "\x1b_octo:/fc\x07";
// CURSOR_MARKER + FAKE_CURSOR_START + text + FAKE_CURSOR_END. Truncating the line right after the cursor cell drops the end.
const FOCUSED_FAKE_CURSOR = /(\x1b_octo:c\x07)\x1b_octo:fc\x07(.*?)(?:\x1b_octo:\/fc\x07|$)/s;

/** Wrap text in fake cursor markers. */
export function renderFakeCursor(text: string): string {
	return `${FAKE_CURSOR_START}${text}${FAKE_CURSOR_END}`;
}

/**
 * Find and extract cursor position from rendered lines.
 * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
 * Only scans the bottom terminal height lines (visible viewport).
 * @param lines - Rendered lines to search
 * @param height - Terminal height (visible viewport size)
 * @returns Cursor position { row, col } or null if no marker found
 */
export function extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
	// Only scan the bottom `height` lines (visible viewport)
	const viewportTop = Math.max(0, lines.length - height);
	for (let row = lines.length - 1; row >= viewportTop; row--) {
		const line = lines[row];
		const markerIndex = line.indexOf(CURSOR_MARKER);
		if (markerIndex !== -1) {
			// Calculate visual column (width of text before marker)
			const beforeMarker = line.slice(0, markerIndex);
			const col = visibleWidth(beforeMarker);

			// Strip marker from the line
			lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);

			return { row, col };
		}
	}
	return null;
}

/**
 * Resolve fake cursor markers to reverse video. When the hardware cursor is shown, a fake cursor
 * directly after CURSOR_MARKER is dropped because the terminal cursor is drawn there. Fake cursors
 * of components without focus have no CURSOR_MARKER and stay visible.
 */
export function resolveFakeCursors(lines: string[], showHardwareCursor: boolean): string[] {
	return lines.map((line) => {
		if (!line.includes(FAKE_CURSOR_START)) return line;
		const resolved = showHardwareCursor ? line.replace(FOCUSED_FAKE_CURSOR, "$1$2") : line;
		return resolved.replaceAll(FAKE_CURSOR_START, "\x1b[7m").replaceAll(FAKE_CURSOR_END, "\x1b[27m");
	});
}
