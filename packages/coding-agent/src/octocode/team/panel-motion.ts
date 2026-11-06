import { animationClock } from "@octocodeai/octocode-tui";
import { markFrameMs, markMoves, type UiState } from "../../theme/status.ts";

/** A mark that may still move: its state and, for a done mark, when it finished. */
export interface Moving {
	state: UiState;
	since?: number;
}

/** A coarse tick this near the wanted boundary is kept rather than re-subscribed on every sync. */
const COARSE_SLOP_MS = 1000;

/**
 * Repaints the panel on the animation clock only while one of its marks moves: a spinner while an agent works, a glow
 * just after one finished. Once every mark is still the subscription ends, so an idle panel writes nothing; the panel's
 * 1 s data refresh stays its own.
 */
export class PanelMotion {
	private stop: (() => void) | undefined;
	private everyMs = 0;
	private fine = false;
	/** When the coarse tick is due: a later sync keeps it unless the wanted minute boundary moved. */
	private coarseDue = 0;

	private readonly marks: (now: number) => Moving[];
	private readonly repaint: () => void;
	private readonly coarse: ((now: number) => number | undefined) | undefined;
	/**
	 * `coarse` answers, while no mark moves, how many ms until the next repaint some still text needs (a count of whole
	 * minutes), or undefined when nothing does: the clock then ticks once for it, and stops when it answers undefined.
	 */
	constructor(marks: (now: number) => Moving[], repaint: () => void, coarse?: (now: number) => number | undefined) {
		this.marks = marks;
		this.repaint = repaint;
		this.coarse = coarse;
	}

	/** Whether marks move now (a spinner or glow): the panel then repaints often enough to show seconds. False on the coarse clock and when stopped. */
	get precise(): boolean {
		return this.fine;
	}

	/** Whether the clock is subscribed for this panel. */
	get active(): boolean {
		return this.stop !== undefined;
	}

	/** Match the subscription to the marks as they are now: subscribe, change cadence, or let go. */
	sync(now: number = Date.now(), ticked = false): void {
		const moving = this.marks(now).filter((mark) =>
			markMoves(mark.state, { now, ...(mark.since === undefined ? {} : { since: mark.since }) }),
		);
		const fineMs = moving.length === 0 ? 0 : Math.min(...moving.map((mark) => markFrameMs(mark.state)));
		const everyMs = fineMs > 0 ? fineMs : (this.coarse?.(now) ?? 0);
		const fine = fineMs > 0;
		// A coarse tick still ahead is kept unless the boundary moved earlier (an older row appeared): a sync right at the
		// boundary must not push the tick a minute out. The tick itself always re-aims at the next boundary.
		const kept = fine
			? everyMs === this.everyMs && this.fine
			: !ticked &&
				!this.fine &&
				this.stop !== undefined &&
				now < this.coarseDue &&
				now + everyMs >= this.coarseDue - COARSE_SLOP_MS;
		if (kept || (everyMs === 0 && this.everyMs === 0)) return;
		this.stop?.();
		this.stop = undefined;
		this.everyMs = everyMs;
		this.coarseDue = now + everyMs;
		this.fine = fine && everyMs > 0;
		if (everyMs === 0) return;
		this.stop = animationClock.subscribe(
			(at) => {
				// Match the clock to the marks first, so the repaint draws the display its cadence can keep true.
				this.sync(at, true);
				this.repaint();
			},
			{ everyMs, kind: fine ? "decor" : "info" },
		);
	}

	dispose(): void {
		this.stop?.();
		this.stop = undefined;
		this.everyMs = 0;
	}
}
