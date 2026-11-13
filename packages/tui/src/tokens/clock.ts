/**
 * One clock for every animation and live counter. Owners subscribe instead of running their own timers; the clock runs
 * a single unref'd interval at the fastest cadence any subscriber needs, stops when the last one leaves, and in reduced
 * motion stops ticking decoration (spinners, shimmer, glow) while counters (elapsed seconds) keep their 1 s tick.
 * While the user scrolls, decoration holds still too, so its repaints do not compete with the scroll's frames.
 */

/** `decor` moves for looks and freezes in reduced motion; `info` shows changing information and always ticks. */
export type AnimationKind = "decor" | "info";

export interface AnimationSubscription {
	/** Wanted interval between calls, in milliseconds. */
	everyMs: number;
	kind: AnimationKind;
}

/** A call this close before its due time counts as due: timers and the millisecond clock disagree by a tick or two. */
const SLACK_MS = 2;

interface Subscriber extends AnimationSubscription {
	listener: (now: number) => void;
	/** When the next call is due; advances by `everyMs` so slower subscribers keep their rate on a faster clock. */
	due: number;
}

class AnimationClock {
	private readonly subscribers = new Set<Subscriber>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private cadence = 0;
	private reduced = false;
	/** Decoration holds still until this time (`Date.now()`), e.g. while the user scrolls. */
	private heldUntil = 0;
	/** When the hold in progress began: decoration drawn from the clock shows this moment until the hold ends. */
	private heldSince = 0;

	/** Call `listener` about every `everyMs` while subscribed; returns the unsubscribe. */
	subscribe(listener: (now: number) => void, options: AnimationSubscription): () => void {
		const everyMs = Math.max(1, options.everyMs);
		const subscriber: Subscriber = { ...options, everyMs, listener, due: Date.now() + everyMs };
		this.subscribers.add(subscriber);
		this.reschedule();
		return () => {
			if (this.subscribers.delete(subscriber)) this.reschedule();
		};
	}

	/** Freeze (`true`) or resume decoration. Counters keep ticking either way. */
	setReducedMotion(reduced: boolean): void {
		if (this.reduced === reduced) return;
		this.reduced = reduced;
		this.reschedule();
		// Let every frozen or resumed owner repaint once in its new state.
		const now = Date.now();
		for (const subscriber of this.subscribers) {
			if (subscriber.kind !== "decor") continue;
			subscriber.due = now + subscriber.everyMs;
			subscriber.listener(now);
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
	 * of a hold in progress, so a frame painted during the hold draws it where it stopped.
	 */
	decorationTime(): number {
		const now = Date.now();
		return now < this.heldUntil ? this.heldSince : now;
	}

	/** Whether a timer is running: false whenever nothing animates (an idle screen writes nothing). */
	isRunning(): boolean {
		return this.timer !== undefined;
	}

	private ticking(): Subscriber[] {
		return [...this.subscribers].filter((subscriber) => !(this.reduced && subscriber.kind === "decor"));
	}

	private reschedule(): void {
		const live = this.ticking();
		const cadence = live.length === 0 ? 0 : Math.min(...live.map((subscriber) => subscriber.everyMs));
		if (cadence === this.cadence && (cadence === 0) === (this.timer === undefined)) return;
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
		this.cadence = cadence;
		if (cadence === 0) return;
		this.timer = setInterval(() => this.tick(), cadence);
		this.timer.unref?.();
	}

	private tick(): void {
		const now = Date.now();
		// The clock ticks at the fastest cadence: a call runs on the first tick at or after its due time (never early, so
		// a counter never shows a second that has not passed), and the next is due `everyMs` after the last due time, not
		// after the late tick, so a 1 s counter on an 80 ms spinner clock keeps a 1 s average without drifting.
		const held = now < this.heldUntil;
		for (const subscriber of this.ticking()) {
			if (!this.subscribers.has(subscriber) || now < subscriber.due - SLACK_MS) continue;
			if (held && subscriber.kind === "decor") continue;
			subscriber.due += subscriber.everyMs;
			// After a stall (a suspended process, frozen decor resuming), restart the rhythm instead of catching up.
			if (subscriber.due <= now) subscriber.due = now + subscriber.everyMs;
			try {
				subscriber.listener(now);
			} catch (error) {
				// A throw out of the timer would end the process and skip the other subscribers: drop the failing animation
				// and report its error as a rejection, which the app shows without exiting.
				this.subscribers.delete(subscriber);
				this.reschedule();
				void Promise.reject(error);
			}
		}
	}
}

/** The process-wide animation clock. */
export const animationClock = new AnimationClock();
export type { AnimationClock };
