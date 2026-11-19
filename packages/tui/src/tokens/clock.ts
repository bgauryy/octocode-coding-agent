/**
 * One clock for every animation and live counter. Owners subscribe instead of running their own timers; the clock runs
 * a single unref'd interval at the fastest cadence any subscriber needs, stops when the last one leaves, and in reduced
 * motion stops ticking decoration (spinners, shimmer, glow) while counters (elapsed seconds) keep their 1 s tick.
 * While the user scrolls, decoration holds still too, so its repaints do not compete with the scroll's frames. While
 * the terminal reports that it lost focus, decoration pauses and repaints once on focus back: an unfocused session
 * repaints only for its counters (each a 1 s tick), so running work still shows it moves.
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

/** No hold lasts longer than this; a hold further ahead of now than this can only come from a wall clock stepped back. */
const MAX_HOLD_AHEAD_MS = 10_000;

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
	/** Whether the terminal has focus; terminals without focus reports never leave `true`. */
	private focused = true;
	/** Decoration holds still until this time (`Date.now()`), e.g. while the user scrolls. */
	private heldUntil = 0;
	/** When the hold in progress began: decoration drawn from the clock shows this moment until the hold ends. */
	private heldSince = 0;
	/** When the terminal lost focus: decoration drawn from the clock shows this moment until focus returns. */
	private blurredAt = 0;
	/** Time advanced by exactly one cadence per tick: a frame index taken from it never repeats or skips with timer jitter. */
	private gridTime = 0;

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
		// Callbacks may replace subscriptions; new owners wait for the next notification.
		const subscribers = [...this.subscribers];
		for (const subscriber of subscribers) {
			if (subscriber.kind !== "decor" || !this.subscribers.has(subscriber)) continue;
			subscriber.due = now + subscriber.everyMs;
			this.notify(subscriber, now);
		}
	}

	/**
	 * Record a focus report (`false`: the terminal lost focus). Unfocused, decoration pauses where it is; counters keep
	 * ticking. Focus back resumes the cadence and repaints decoration once.
	 */
	setFocused(focused: boolean): void {
		if (this.focused === focused) return;
		this.focused = focused;
		if (!focused) this.blurredAt = Date.now();
		this.reschedule();
		if (!focused) return;
		const now = Date.now();
		// Callbacks may replace subscriptions; iterate a snapshot.
		const subscribers = [...this.subscribers];
		for (const subscriber of subscribers) {
			if (subscriber.kind !== "decor" || this.reduced || !this.subscribers.has(subscriber)) continue;
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
	 * The time decoration drawn from the clock (a shimmer band, a spinner glyph picked by time) shows: now, the moment
	 * focus left, or the start of a hold in progress, so a frame painted meanwhile (a counter's tick) draws it where it
	 * stopped.
	 */
	decorationTime(): number {
		if (!this.focused) return this.blurredAt;
		const now = Date.now();
		return now < this.heldUntil ? this.heldSince : now;
	}

	/**
	 * The time a looping animation takes its frame from: while the clock ticks it moves by one cadence per tick, so a
	 * frame index `floor(frameTime() / everyMs)` advances once per tick even when ticks arrive late or early; it follows
	 * wall time after a stall. Paused or held decoration shows the moment it stopped, as `decorationTime()` does.
	 */
	frameTime(): number {
		if (this.timer === undefined || !this.focused || Date.now() < this.heldUntil) return this.decorationTime();
		return this.gridTime;
	}

	/** Whether a timer is running: false whenever nothing animates (an idle screen writes nothing). */
	isRunning(): boolean {
		return this.timer !== undefined;
	}

	private ticking(): Subscriber[] {
		const paused = this.reduced || !this.focused;
		return [...this.subscribers].filter((subscriber) => !(paused && subscriber.kind === "decor"));
	}

	private reschedule(): void {
		const live = this.ticking();
		const cadence = live.length === 0 ? 0 : Math.min(...live.map((subscriber) => subscriber.everyMs));
		if (cadence === this.cadence && (cadence === 0) === (this.timer === undefined)) return;
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
		this.cadence = cadence;
		if (cadence === 0) return;
		this.gridTime = Date.now();
		this.timer = setInterval(() => this.tick(), cadence);
		this.timer.unref?.();
	}

	/** Mode changes and regular ticks isolate failed callbacks in the same way. */
	private notify(subscriber: Subscriber, now: number): void {
		try {
			subscriber.listener(now);
		} catch (error) {
			// Drop the failing animation and report its error as a rejection, which the app shows without exiting.
			this.subscribers.delete(subscriber);
			this.reschedule();
			void Promise.reject(error);
		}
	}

	private tick(): void {
		const now = Date.now();
		// Steady ticks advance the frame time by one cadence; a stall or a wall clock step puts it back on wall time.
		this.gridTime =
			now - this.gridTime > 2 * this.cadence || this.gridTime - now > this.cadence ? now : this.gridTime + this.cadence;
		// The clock ticks at the fastest cadence: a call runs on the first tick at or after its due time (never early, so
		// a counter never shows a second that has not passed), and the next is due `everyMs` after the last due time, not
		// after the late tick, so a 1 s counter on an 80 ms spinner clock keeps a 1 s average without drifting.
		// A wall clock stepped back leaves due times and the hold far ahead of now: pull them in so ticks resume within
		// one interval.
		if (this.heldUntil - now > MAX_HOLD_AHEAD_MS) this.heldUntil = now;
		const held = now < this.heldUntil;
		for (const subscriber of this.ticking()) {
			if (!this.subscribers.has(subscriber)) continue;
			if (subscriber.due - now > subscriber.everyMs) subscriber.due = now;
			if (now < subscriber.due - SLACK_MS) continue;
			if (held && subscriber.kind === "decor") continue;
			const every = subscriber.everyMs;
			subscriber.due += every;
			// After a stall (a suspended process, frozen decor resuming), restart the rhythm instead of catching up.
			if (subscriber.due <= now) subscriber.due = now + every;
			this.notify(subscriber, now);
		}
	}
}

/** The process-wide animation clock. */
export const animationClock = new AnimationClock();
export type { AnimationClock };
