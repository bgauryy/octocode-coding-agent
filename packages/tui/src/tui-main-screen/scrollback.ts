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
export class ScrollbackPolicy {
	private previousLayout: readonly LayoutLeaf[] | undefined;

	/** Forget the last frame's layout: the next change above the viewport replays. */
	reset(): void {
		this.previousLayout = undefined;
	}

	/** Take the frame's layout as the one to compare with next; returns the one it replaces. Call once per frame. */
	advance(layout: readonly LayoutLeaf[]): readonly LayoutLeaf[] | undefined {
		const previous = this.previousLayout;
		this.previousLayout = layout;
		return previous;
	}

	/** Whether the changes above `viewportTop` are in-place edits that need no replay. */
	canDefer(options: {
		previousLayout: readonly LayoutLeaf[] | undefined;
		layout: readonly LayoutLeaf[];
		previousLines: readonly string[];
		newLines: readonly string[];
		viewportTop: number;
		repaintRequested: boolean;
	}): boolean {
		const { previousLayout, previousLines, newLines, viewportTop } = options;
		if (options.repaintRequested || !previousLayout || newLines.length <= viewportTop) return false;
		if (!sameLayoutAbove(previousLayout, options.layout, viewportTop)) return false;
		// An image above the viewport is uploaded once and tracked by id; it is replayed, not skipped.
		for (let row = 0; row < viewportTop; row++) {
			if (previousLines[row] === newLines[row]) continue;
			if (isImageLine(previousLines[row] ?? "") || isImageLine(newLines[row] ?? "")) return false;
		}
		return true;
	}
}
