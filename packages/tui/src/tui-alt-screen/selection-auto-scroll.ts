import type { ScrollView } from "../components/scroll-view.ts";
import { animationClock } from "../tokens/clock.ts";

/**
 * How often a drag held past the edge of its scroll view scrolls it: the streaming frame floor (25 fps). Each tick
 * scrolls the whole lines its speed has earned, so the view moves in small even steps; a faster cadence would put
 * synchronized-output frames closer than xterm.js paints them.
 */
export const AUTO_SCROLL_INTERVAL_MS = 40;
/** The time a speed is given in: `step` lines per this many milliseconds. */
const SPEED_UNIT_MS = 50;
/** Time at one speed before a held drag speeds up by a step. */
const AUTO_SCROLL_RAMP_MS = 500;
/** The fastest speed in lines per `SPEED_UNIT_MS`: the wheel's per-frame cap. */
export const AUTO_SCROLL_MAX_LINES = 24;

/** What auto-scroll reads from the selection: the anchored view's visible rows, and how to extend to the pointer. */
export interface SelectionAutoScrollHost {
	/** The scroll view the selection is anchored in, with its first and last terminal rows on screen. */
	visibleRows(): { scrollView: ScrollView; visibleTop: number; visibleBottom: number } | undefined;
	/** Move the selection focus to the pointer after the view moved under it. */
	extendTo(scrollView: ScrollView, x: number, y: number): void;
	requestRender(): void;
}

/**
 * Scrolls a selection drag held on or past the edge of its scroll view. The step grows with the pointer's distance
 * past the edge (the editor and footer rows below the transcript give room) and with how long the drag is held, so a
 * drag at the screen's top row, which cannot go further, still crosses a long transcript in seconds.
 */
export class SelectionAutoScroll {
	private readonly host: SelectionAutoScrollHost;
	private pointer?: { x: number; y: number };
	private direction: -1 | 0 | 1 = 0;
	private distance = 0;
	private heldMs = 0;
	/** Earned scroll not yet taken, in line-milliseconds; it starts at one line so the first tick moves at once. */
	private carry = SPEED_UNIT_MS;
	/** The animation clock subscription while a drag scrolls. */
	private timer?: () => void;

	constructor(host: SelectionAutoScrollHost) {
		this.host = host;
	}

	get active(): boolean {
		return this.timer !== undefined;
	}

	/** The speed now, in lines per 50 ms. */
	get step(): number {
		return Math.min(AUTO_SCROLL_MAX_LINES, this.distance + Math.floor(this.heldMs / AUTO_SCROLL_RAMP_MS));
	}

	/** Follow a drag motion: start, retarget or stop scrolling by where the pointer is. */
	update(pointer: { x: number; y: number }): void {
		const visible = this.host.visibleRows();
		if (!visible) {
			this.stop();
			return;
		}
		const { visibleTop, visibleBottom } = visible;
		const direction = pointer.y <= visibleTop ? -1 : pointer.y >= visibleBottom ? 1 : 0;
		if (direction === 0) {
			this.stop();
			return;
		}
		if (direction !== this.direction) this.restartSpeed();
		this.pointer = { x: pointer.x, y: pointer.y };
		this.direction = direction;
		this.distance = direction < 0 ? visibleTop - pointer.y + 1 : pointer.y - visibleBottom + 1;
		if (this.timer) return;
		// `info`: the scroll follows the user's drag, so reduced motion and decoration holds do not stop it.
		this.timer = animationClock.subscribe(() => this.tick(), { everyMs: AUTO_SCROLL_INTERVAL_MS, kind: "info" });
	}

	private restartSpeed(): void {
		this.heldMs = 0;
		this.carry = SPEED_UNIT_MS;
	}

	/** Scroll the whole lines earned since the last tick; stop at the end of the content. */
	tick(): void {
		const visible = this.host.visibleRows();
		const pointer = this.pointer;
		if (!visible || !pointer || this.direction === 0) {
			this.stop();
			return;
		}
		this.carry += this.step * AUTO_SCROLL_INTERVAL_MS;
		this.heldMs += AUTO_SCROLL_INTERVAL_MS;
		const whole = Math.floor(this.carry / SPEED_UNIT_MS);
		if (whole === 0) return;
		this.carry -= whole * SPEED_UNIT_MS;
		const lines = this.direction * whole;
		if (visible.scrollView.scrollBy(lines) === lines) {
			this.stop();
			return;
		}
		this.host.extendTo(visible.scrollView, pointer.x, pointer.y);
		this.host.requestRender();
	}

	stop(): void {
		this.timer?.();
		this.timer = undefined;
		this.pointer = undefined;
		this.direction = 0;
		this.distance = 0;
		this.restartSpeed();
	}
}
