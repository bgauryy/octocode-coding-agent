import { isImageLine } from "../terminal-image.ts";
import { type LayoutLeaf, sameLayoutAbove } from "../tui/layout-recorder.ts";

/**
 * Decides whether rows that changed above the viewport may be left alone.
 *
 * The terminal owns scrollback and cannot edit it: a diff can only write rows that are on screen. The one way to
 * change a scrolled-off row is to clear the screen and scrollback and write the whole transcript again, which flickers
 * and throws the reader out of their scroll position. That price is right when the transcript itself changed (rows
 * were added, removed or resized, or every row was restyled) and wrong for a live value ticking on a row that
 * scrolled away: a tool's elapsed time, a status word, a spinner mark. The two differ in layout: an in-place edit
 * leaves every leaf component on the row where it started.
 */
/** A frame's layout; its leaves are built only when asked for. */
interface FrameLayout {
	readonly leaves: readonly LayoutLeaf[];
}

export class ScrollbackPolicy {
	private previousLayout: FrameLayout | undefined;

	/** Forget the last frame's layout: the next change above the viewport replays. */
	reset(): void {
		this.previousLayout = undefined;
	}

	/** Take the frame's layout as the one to compare with next; returns the one it replaces. Call once per frame. */
	advance(layout: FrameLayout): FrameLayout | undefined {
		const previous = this.previousLayout;
		this.previousLayout = layout;
		return previous;
	}

	/** Whether the changes above `viewportTop` are in-place edits that need no replay. */
	canDefer(options: {
		previousLayout: FrameLayout | undefined;
		layout: FrameLayout;
		previousLines: readonly string[];
		newLines: readonly string[];
		viewportTop: number;
		repaintRequested: boolean;
		/** Rows before it are equal in both frames. */
		firstChanged?: number;
	}): boolean {
		const { previousLayout, previousLines, newLines, viewportTop } = options;
		if (options.repaintRequested || !previousLayout || newLines.length <= viewportTop) return false;
		if (!sameLayoutAbove(previousLayout.leaves, options.layout.leaves, viewportTop)) return false;
		// An image above the viewport is uploaded once and tracked by id; it is replayed, not skipped.
		for (let row = Math.max(0, options.firstChanged ?? 0); row < viewportTop; row++) {
			if (previousLines[row] === newLines[row]) continue;
			if (isImageLine(previousLines[row] ?? "") || isImageLine(newLines[row] ?? "")) return false;
		}
		return true;
	}
}

/** Rows a replay writes by default: a terminal's usual scrollback, a fraction of a long session's transcript. */
export const DEFAULT_REPLAY_ROWS = 5000;

/** The row standing for the rows a bounded replay leaves out. */
const replayMarker = (rows: number): string =>
	`\x1b[2m··· ${rows.toLocaleString("en-US")} earlier rows not redrawn ···\x1b[22m`;

/**
 * The rows a replay writes: the last `limit` (never fewer than a screen) after one marker row for the rest. The terminal
 * clears its scrollback before a replay, so the left-out rows were not in it either way; the frame keeps every row, and
 * the rows on screen are the same as a full replay's, so later frames diff as before.
 */
export function replayTail(lines: string[], limit: number, height: number): string[] {
	if (limit <= 0) return lines;
	const keep = Math.max(limit, height);
	if (lines.length <= keep + 1) return lines;
	const hidden = lines.length - keep;
	const tail = lines.slice(hidden);
	tail.unshift(replayMarker(hidden));
	return tail;
}
