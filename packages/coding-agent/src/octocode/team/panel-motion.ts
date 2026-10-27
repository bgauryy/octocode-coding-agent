import { animationClock } from "@octocodeai/octocode-tui";
import { markFrameMs, markMoves, type UiState } from "../../theme/status.ts";

/** A mark that may still move: its state and, for a done mark, when it finished. */
export interface Moving {
	state: UiState;
	since?: number;
}

/**
 * Repaints the panel on the animation clock only while one of its marks moves: a spinner while an agent works, a glow
 * just after one finished. Once every mark is still the subscription ends, so an idle panel writes nothing; the panel's
 * 1 s data refresh stays its own.
 */
export class PanelMotion {
	private stop: (() => void) | undefined;
	private everyMs = 0;

	private readonly marks: (now: number) => Moving[];
	private readonly repaint: () => void;
	constructor(marks: (now: number) => Moving[], repaint: () => void) {
		this.marks = marks;
		this.repaint = repaint;
	}

	/** Whether the clock is subscribed for this panel. */
	get active(): boolean {
		return this.stop !== undefined;
	}

	/** Match the subscription to the marks as they are now: subscribe, change cadence, or let go. */
	sync(now: number = Date.now()): void {
		const moving = this.marks(now).filter((mark) =>
			markMoves(mark.state, { now, ...(mark.since === undefined ? {} : { since: mark.since }) }),
		);
		const everyMs = moving.length === 0 ? 0 : Math.min(...moving.map((mark) => markFrameMs(mark.state)));
		if (everyMs === this.everyMs) return;
		this.stop?.();
		this.stop = undefined;
		this.everyMs = everyMs;
		if (everyMs === 0) return;
		this.stop = animationClock.subscribe(
			(at) => {
				this.repaint();
				this.sync(at);
			},
			{ everyMs, kind: "decor" },
		);
	}

	dispose(): void {
		this.stop?.();
		this.stop = undefined;
		this.everyMs = 0;
	}
}
