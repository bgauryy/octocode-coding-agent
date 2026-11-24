import { animationClock, MOTION } from "@octocodeai/octocode-tui";
import type { UiState } from "../../../theme/status.ts";

/** A row's state: a running one keeps the panel's second clock ticking. */
export interface Moving {
	state: UiState;
}

/** A coarse tick this near the wanted boundary is kept rather than re-subscribed on every sync. */
const COARSE_SLOP_MS = 1000;

/**
 * Repaints the panel on the animation clock once a second while one of its rows runs: the rows' clocks count seconds
 * and a child's new row is found. The state lights never move, so nothing ticks faster. Once no row runs the
 * subscription ends, so an idle panel writes nothing.
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

	/** Whether a row runs now: the panel then repaints often enough to show seconds. False on the coarse clock and when stopped. */
	get precise(): boolean {
		return this.fine;
	}

	/** Whether the clock is subscribed for this panel. */
	get active(): boolean {
		return this.stop !== undefined;
	}

	/** Match the subscription to the marks as they are now: subscribe, change cadence, or let go. */
	sync(now: number = Date.now(), ticked = false): void {
		const fineMs = this.marks(now).some((mark) => mark.state === "running") ? MOTION.tickMs : 0;
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
			{ everyMs, kind: "info" },
		);
	}

	dispose(): void {
		this.stop?.();
		this.stop = undefined;
		this.everyMs = 0;
	}
}
