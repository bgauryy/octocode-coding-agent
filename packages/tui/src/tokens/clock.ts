import { Clock, type ClockSubscriber, type ClockSubscription } from "@octocodeai/octocode-common/clock";
import { MOTION } from "./design.ts";

/**
 * One clock for every animation and live counter. Owners subscribe instead of running their own timers; the clock runs
 * a single unref'd interval at the fastest cadence any subscriber needs, stops when the last one leaves, and in reduced
 * motion stops ticking decoration (spinners, shimmer, glow) while counters (elapsed seconds) keep their 1 s tick.
 * While the user scrolls, decoration holds still too, so its repaints do not compete with the scroll's frames. While
 * the terminal reports that it lost focus, decoration slows to a step every `MOTION.unfocusedDecorMs` (reduced motion
 * still stops it) and returns to full speed at once on focus back; counters keep their 1 s tick.
 */

/** `decor` moves for looks and freezes in reduced motion; `info` shows changing information and always ticks. */
export type AnimationKind = "decor" | "info";

export interface AnimationSubscription extends ClockSubscription {
	kind: AnimationKind;
}

/** No hold lasts longer than this; a hold further ahead of now than this can only come from a wall clock stepped back. */
const MAX_HOLD_AHEAD_MS = 10_000;

type Subscriber = ClockSubscriber<AnimationSubscription>;

class AnimationClock extends Clock<AnimationSubscription> {
	private reduced = false;
	/** Whether the terminal has focus; terminals without focus reports never leave `true`. */
	private focused = true;
	/** Decoration holds still until this time (`Date.now()`), e.g. while the user scrolls. */
	private heldUntil = 0;
	/** When the hold in progress began: decoration drawn from the clock shows this moment until the hold ends. */
	private heldSince = 0;
	/** Time advanced by exactly one cadence per tick: a frame index taken from it never repeats or skips with timer jitter. */
	private gridTime = 0;

	/** Freeze (`true`) or resume decoration. Counters keep ticking either way. */
	setReducedMotion(reduced: boolean): void {
		if (this.reduced === reduced) return;
		this.reduced = reduced;
		this.reschedule();
		// Let every frozen or resumed owner repaint once in its new state.
		const now = Date.now();
		// Callbacks may replace subscriptions; new owners wait for the next notification.
		const subscribers = [...this.subscribers];
		for (const subscriber of subscribers) {
			if (subscriber.options.kind !== "decor" || !this.subscribers.has(subscriber)) continue;
			subscriber.due = now + subscriber.everyMs;
			this.notify(subscriber, now);
		}
	}

	/**
	 * Record a focus report (`false`: the terminal lost focus). Unfocused, decoration steps every
	 * `MOTION.unfocusedDecorMs` at most; counters keep ticking. Focus back resumes the cadence and repaints decoration once.
	 */
	setFocused(focused: boolean): void {
		if (this.focused === focused) return;
		this.focused = focused;
		this.reschedule();
		if (!focused) return;
		const now = Date.now();
		// Callbacks may replace subscriptions; iterate a snapshot.
		const subscribers = [...this.subscribers];
		for (const subscriber of subscribers) {
			if (subscriber.options.kind !== "decor" || this.reduced || !this.subscribers.has(subscriber)) continue;
			subscriber.due = now + subscriber.everyMs;
			this.notify(subscriber, now);
		}
	}

	isReducedMotion(): boolean {
		return this.reduced;
	}

	/**
	 * Hold decoration still for `ms` from now (extending a hold in progress): its calls wait and resume on the first
	 * tick after the hold. Counters keep ticking, and owners still repaint for changes of their own.
	 */
	holdDecoration(ms: number): void {
		const now = Date.now();
		if (now >= this.heldUntil) this.heldSince = now;
		this.heldUntil = Math.max(this.heldUntil, now + Math.max(0, ms));
	}

	/**
	 * The time decoration drawn from the clock (a shimmer band, a spinner glyph picked by time) shows: now, or the start
	 * of a hold in progress, so a frame painted meanwhile (a counter's tick) draws it where it stopped.
	 */
	decorationTime(): number {
		const now = Date.now();
		return now < this.heldUntil ? this.heldSince : now;
	}

	/**
	 * The time a looping animation takes its frame from: while the clock ticks it moves by one cadence per tick, so a
	 * frame index `floor(frameTime() / everyMs)` advances once per tick even when ticks arrive late or early; it follows
	 * wall time after a stall. Held decoration shows the moment it stopped, as `decorationTime()` does.
	 */
	frameTime(): number {
		if (this.timer === undefined || Date.now() < this.heldUntil) return this.decorationTime();
		return this.gridTime;
	}

	protected override isLive(subscriber: Subscriber): boolean {
		return !(this.reduced && subscriber.options.kind === "decor");
	}

	/** The interval a subscriber is served at now: decoration is no faster than `unfocusedDecorMs` while unfocused. */
	protected override wantedMs(subscriber: Subscriber): number {
		if (subscriber.options.kind === "decor" && !this.focused) {
			return Math.max(subscriber.everyMs, MOTION.unfocusedDecorMs);
		}
		return subscriber.everyMs;
	}

	protected override timerStarted(now: number): void {
		this.gridTime = now;
	}

	/** Decoration steps by whole ticks so its motion is evenly spaced; counters keep their exact interval. */
	protected override stepMs(subscriber: Subscriber, wanted: number): number {
		return subscriber.options.kind === "decor" ? Math.max(1, Math.round(wanted / this.cadence)) * this.cadence : wanted;
	}

	protected override isDeferred(subscriber: Subscriber): boolean {
		return subscriber.options.kind === "decor" && Date.now() < this.heldUntil;
	}

	/** Drop the failing animation and report its error as a rejection, which the app shows without exiting. */
	protected override failed(subscriber: Subscriber, error: unknown): void {
		this.subscribers.delete(subscriber);
		this.reschedule();
		void Promise.reject(error);
	}

	protected override beforeTick(now: number): void {
		// Steady ticks advance the frame time by one cadence; a stall or a wall clock step puts it back on wall time.
		this.gridTime =
			now - this.gridTime > 2 * this.cadence || this.gridTime - now > this.cadence ? now : this.gridTime + this.cadence;
		// A wall clock stepped back leaves the hold far ahead of now: pull it in so decoration resumes within one interval.
		if (this.heldUntil - now > MAX_HOLD_AHEAD_MS) this.heldUntil = now;
	}
}

/** The process-wide animation clock. */
export const animationClock = new AnimationClock();

/**
 * The frame of a looping animation now: every spinner reads it, so all of them show the same frame and none keeps a
 * counter. It steps once per `everyMs` of the clock's frame time; undefined for no frames.
 */
export function spinnerFrame<T>(frames: readonly T[], everyMs: number = MOTION.spinnerMs): T | undefined {
	if (frames.length === 0) return undefined;
	return frames[Math.floor(animationClock.frameTime() / Math.max(1, everyMs)) % frames.length];
}
export type { AnimationClock };
