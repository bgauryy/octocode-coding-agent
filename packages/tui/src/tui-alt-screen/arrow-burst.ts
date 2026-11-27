import { BURST_GAP_MS, type WheelScrollAccelerator } from "../wheel-scroll.ts";

/** Plain Up and Down in both cursor-key modes: what a terminal's alternate-scroll mode sends for a wheel. */
const ARROW_DIRECTION: Readonly<Record<string, -1 | 1>> = {
	"\x1b[A": -1,
	"\x1bOA": -1,
	"\x1b[B": 1,
	"\x1bOB": 1,
};

/**
 * Turns a burst of arrow keys into transcript scrolling. A terminal that turns the wheel into Up and Down keys sends
 * several within a few milliseconds; a person's key press or key repeat never does. A lone arrow is held for
 * `BURST_GAP_MS`: another arrow inside that window makes both, and every arrow that follows within the window of its
 * predecessor, scroll like wheel events and never reach the editor (history recall, cursor). With no second arrow the
 * held one is delivered as a key press, and any other input delivers it first so keys keep their order.
 */
export class ArrowBurstScroll {
	private held: { data: string; direction: -1 | 1 } | undefined;
	private timer: NodeJS.Timeout | undefined;
	private lastArrowAt = Number.NEGATIVE_INFINITY;

	private readonly wheelScroll: WheelScrollAccelerator;
	private readonly scrollBy: (lines: number) => void;
	private readonly deliver: (data: string) => void;

	/** `deliver` gives input to the focused component, as if no listener had held it. */
	constructor(wheelScroll: WheelScrollAccelerator, scrollBy: (lines: number) => void, deliver: (data: string) => void) {
		this.wheelScroll = wheelScroll;
		this.scrollBy = scrollBy;
		this.deliver = deliver;
	}

	/** True when the input was an arrow this took over. */
	handle(data: string, now: number = performance.now()): boolean {
		const direction = ARROW_DIRECTION[data];
		if (direction === undefined) {
			this.flush();
			return false;
		}
		const inBurst = now - this.lastArrowAt < BURST_GAP_MS;
		this.lastArrowAt = now;
		if (this.held) {
			const first = this.held.direction;
			this.release();
			this.scroll(first, now);
			this.scroll(direction, now);
		} else if (inBurst) {
			this.scroll(direction, now);
		} else {
			this.held = { data, direction };
			this.timer = setTimeout(() => this.flush(), BURST_GAP_MS);
			this.timer.unref();
		}
		return true;
	}

	/** Deliver a held arrow as the key press it was. */
	flush(): void {
		const held = this.held;
		this.release();
		if (held) this.deliver(held.data);
	}

	/** Drop a held arrow: the screen is stopping or lost focus. */
	cancel(): void {
		this.release();
		this.lastArrowAt = Number.NEGATIVE_INFINITY;
	}

	private release(): void {
		this.held = undefined;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private scroll(direction: -1 | 1, now: number): void {
		const lines = this.wheelScroll.next(direction, now);
		if (lines > 0) this.scrollBy(direction * lines);
	}
}
