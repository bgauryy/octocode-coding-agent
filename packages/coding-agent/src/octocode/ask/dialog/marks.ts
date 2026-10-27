import { animationClock } from "@octocodeai/octocode-tui";
import { markFrameMs, markMoves, stateMark } from "../../../theme/status.ts";
import type { DialogTheme } from "./theme.ts";

/** A question tab's mark: `✓` once answered, `◇` while it waits on the user (breathing; still in reduced motion). */
export const tabMark = (theme: DialogTheme, answered: boolean, now: number = Date.now()): string =>
	stateMark(theme, answered ? "done" : "waiting", { now });

/**
 * Repaints the dialog on the animation clock while some question is unanswered, and not otherwise: an answered dialog
 * and reduced motion hold still.
 */
export class Breath {
	private stop: (() => void) | undefined;
	private readonly repaint: () => void;
	constructor(repaint: () => void) {
		this.repaint = repaint;
	}

	/** Whether the clock is subscribed. */
	get active(): boolean {
		return this.stop !== undefined;
	}

	/** Breathe while `waiting` (some question unanswered) and motion is allowed. */
	sync(waiting: boolean): void {
		if (waiting && markMoves("waiting")) {
			this.stop ??= animationClock.subscribe(this.repaint, { everyMs: markFrameMs("waiting"), kind: "decor" });
		} else this.dispose();
	}

	dispose(): void {
		this.stop?.();
		this.stop = undefined;
	}
}
