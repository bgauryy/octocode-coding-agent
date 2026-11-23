import type { ScrollView } from "../components/scroll-view.ts";

/** How often a drag held past the edge of its scroll view scrolls it. */
const AUTO_SCROLL_INTERVAL_MS = 50;
/** Ticks at one speed before a held drag speeds up by a line per tick. */
const AUTO_SCROLL_RAMP_TICKS = 10;
/** The most lines one tick scrolls: the wheel's per-frame cap. */
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
	private ticks = 0;
	private timer?: NodeJS.Timeout;

	constructor(host: SelectionAutoScrollHost) {
		this.host = host;
	}

	get active(): boolean {
		return this.timer !== undefined;
	}

	/** Lines the next tick scrolls. */
	get step(): number {
		return Math.min(AUTO_SCROLL_MAX_LINES, this.distance + Math.floor(this.ticks / AUTO_SCROLL_RAMP_TICKS));
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
		if (direction !== this.direction) this.ticks = 0;
		this.pointer = { x: pointer.x, y: pointer.y };
		this.direction = direction;
		this.distance = direction < 0 ? visibleTop - pointer.y + 1 : pointer.y - visibleBottom + 1;
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), AUTO_SCROLL_INTERVAL_MS);
		this.timer.unref();
	}

	/** Scroll one step; stop at the end of the content. */
	tick(): void {
		const visible = this.host.visibleRows();
		const pointer = this.pointer;
		if (!visible || !pointer || this.direction === 0) {
			this.stop();
			return;
		}
		const lines = this.direction * this.step;
		this.ticks += 1;
		if (visible.scrollView.scrollBy(lines) === lines) {
			this.stop();
			return;
		}
		this.host.extendTo(visible.scrollView, pointer.x, pointer.y);
		this.host.requestRender();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.pointer = undefined;
		this.direction = 0;
		this.distance = 0;
		this.ticks = 0;
	}
}
