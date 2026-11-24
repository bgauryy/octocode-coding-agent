import { animationClock } from "@octocodeai/octocode-tui";
import { MARK_FRAME_MS, markMoves, stateMark } from "../../../theme/status.ts";
import type { DialogTheme } from "./theme.ts";

/** When each open dialog's pulse began; a tab mark holds still once the oldest has pulsed for `WAIT_PULSE_MS`. */
const pulses = new Set<Breath>();

const pulseSince = (): number | undefined => {
	let first: number | undefined;
	for (const breath of pulses)
		if (breath.since !== undefined && (first === undefined || breath.since < first)) first = breath.since;
	return first;
};

/**
 * A question tab's mark: `✓` once answered, `◇` while it waits on the user (breathing for a few seconds, then still;
 * still in reduced motion).
 */
export const tabMark = (theme: DialogTheme, answered: boolean, now: number = Date.now()): string => {
	const since = answered ? undefined : pulseSince();
	return stateMark(theme, answered ? "done" : "waiting", since === undefined ? { now } : { now, since });
};

/**
 * Repaints the dialog on the animation clock while some question is unanswered and its pulse still moves, and not
 * otherwise: an answered dialog, reduced motion and a dialog that has waited past `WAIT_PULSE_MS` hold still.
 */
export class Breath {
	private stop: (() => void) | undefined;
	private readonly repaint: () => void;
	/** When the pulse began. */
	since: number | undefined;
	constructor(repaint: () => void) {
		this.repaint = repaint;
	}

	/** Whether the clock is subscribed. */
	get active(): boolean {
		return this.stop !== undefined;
	}

	/** Breathe while `waiting` (some question unanswered), motion is allowed and the pulse has not run its bound. */
	sync(waiting: boolean): void {
		if (!waiting) return this.dispose();
		if (this.since === undefined) {
			if (!markMoves("waiting")) return;
			this.since = Date.now();
			pulses.add(this);
		}
		if (!markMoves("waiting", { since: this.since })) return this.stopClock();
		this.stop ??= animationClock.subscribe(
			() => {
				this.repaint();
				// Past the bound the repaint above drew the still mark: let the clock go.
				if (!markMoves("waiting", { since: this.since! })) this.stopClock();
			},
			{ everyMs: MARK_FRAME_MS, kind: "decor" },
		);
	}

	dispose(): void {
		this.stopClock();
		this.since = undefined;
		pulses.delete(this);
	}

	private stopClock(): void {
		this.stop?.();
		this.stop = undefined;
	}
}
