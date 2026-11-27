/**
 * One shared interval timer for periodic work. Owners subscribe with the interval they want instead of running their
 * own `setInterval`; the clock runs a single unref'd timer at the fastest cadence any live subscriber needs and stops
 * when the last one leaves, so an idle process wakes nothing.
 *
 * Subclasses add policy through the protected hooks (which subscribers are live, how fast each is served, when a due
 * call waits); the scheduling stays here.
 */

export interface ClockSubscription {
	/** Wanted interval between calls, in milliseconds. */
	everyMs: number;
}

/** A call this close before its due time counts as due: timers and the millisecond clock disagree by a tick or two. */
const SLACK_MS = 2;

export interface ClockSubscriber<O extends ClockSubscription> {
	options: O;
	everyMs: number;
	listener: (now: number) => void;
	/** When the next call is due; advances by the interval so slower subscribers keep their rate on a faster clock. */
	due: number;
}

export class Clock<O extends ClockSubscription = ClockSubscription> {
	protected readonly subscribers = new Set<ClockSubscriber<O>>();
	protected timer: NodeJS.Timeout | undefined;
	protected cadence = 0;

	/** Call `listener` about every `options.everyMs` while subscribed; returns the unsubscribe. */
	subscribe(listener: (now: number) => void, options: O): () => void {
		const everyMs = Math.max(1, options.everyMs);
		// Joining a timer that already ticks at this rate: the first call comes on its next tick, not a full interval later.
		const joinsRunning = this.timer !== undefined && this.cadence === everyMs;
		const subscriber: ClockSubscriber<O> = {
			options,
			everyMs,
			listener,
			due: Date.now() + (joinsRunning ? 0 : everyMs),
		};
		this.subscribers.add(subscriber);
		this.reschedule();
		return () => {
			if (this.subscribers.delete(subscriber)) this.reschedule();
		};
	}

	/** Whether a timer is running: false whenever nothing is subscribed (or live). */
	isRunning(): boolean {
		return this.timer !== undefined;
	}

	/** Whether a subscriber ticks at all now. */
	protected isLive(_subscriber: ClockSubscriber<O>): boolean {
		return true;
	}

	/** The interval a subscriber is served at now. */
	protected wantedMs(subscriber: ClockSubscriber<O>): number {
		return subscriber.everyMs;
	}

	/** How far a call advances its due time: `wanted` unless the policy rounds to whole ticks. */
	protected stepMs(_subscriber: ClockSubscriber<O>, wanted: number): number {
		return wanted;
	}

	/** Whether a due call waits for a later tick without advancing its due time. */
	protected isDeferred(_subscriber: ClockSubscriber<O>): boolean {
		return false;
	}

	/** Runs when a new timer starts. */
	protected timerStarted(_now: number): void {}

	/** Runs at the start of every tick, before any call. */
	protected beforeTick(_now: number): void {}

	/** A failing listener keeps its subscription; its error surfaces as an unhandled rejection, never out of the timer. */
	protected failed(_subscriber: ClockSubscriber<O>, error: unknown): void {
		void Promise.reject(error);
	}

	/** Call one listener; a throw never stops the other listeners of the tick. */
	protected notify(subscriber: ClockSubscriber<O>, now: number): void {
		try {
			subscriber.listener(now);
		} catch (error) {
			this.failed(subscriber, error);
		}
	}

	protected ticking(): ClockSubscriber<O>[] {
		return [...this.subscribers].filter((subscriber) => this.isLive(subscriber));
	}

	protected reschedule(): void {
		const live = this.ticking();
		const cadence = live.length === 0 ? 0 : Math.min(...live.map((subscriber) => this.wantedMs(subscriber)));
		if (cadence === this.cadence && (cadence === 0) === (this.timer === undefined)) return;
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
		this.cadence = cadence;
		if (cadence === 0) return;
		this.timerStarted(Date.now());
		// oxlint-disable-next-line no-restricted-globals -- the one raw interval every shared-clock subscriber rides
		this.timer = setInterval(() => this.tick(), cadence);
		this.timer.unref?.();
	}

	private tick(): void {
		const now = Date.now();
		this.beforeTick(now);
		// The clock ticks at the fastest cadence: a call runs on the first tick at or after its due time (never early, so
		// a counter never shows a second that has not passed), and the next is due one interval after the last due time,
		// not after the late tick, so a 1 s counter on an 80 ms clock keeps a 1 s average without drifting.
		for (const subscriber of this.ticking()) {
			if (!this.subscribers.has(subscriber)) continue;
			const wanted = this.wantedMs(subscriber);
			// A wall clock stepped back leaves due times far ahead of now: pull them in so ticks resume within one interval.
			if (subscriber.due - now > wanted) subscriber.due = now;
			if (now < subscriber.due - SLACK_MS) continue;
			if (this.isDeferred(subscriber)) continue;
			const every = this.stepMs(subscriber, wanted);
			subscriber.due += every;
			// After a stall (a suspended process), restart the rhythm instead of catching up.
			if (subscriber.due <= now) subscriber.due = now + every;
			this.notify(subscriber, now);
		}
	}
}

/** The process-wide clock for work that needs no policy of its own (see `onSecond` and `everyMs` users). */
export const sharedClock = new Clock();
