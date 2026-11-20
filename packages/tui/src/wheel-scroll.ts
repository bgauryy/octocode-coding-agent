/** Lines moved per mouse-wheel event, or `"auto"` to accelerate fast wheel spins. */
export type WheelScrollLines = number | "auto";

// Lines one wheel notch moves when nothing says otherwise: vim and neovim (`mousescroll` ver:3) use 3. A terminal that
// sends one event per notch (Terminal.app while scrolling slowly, VS Code) and one that accelerates on its own cannot be
// told apart, so an isolated event moves this many lines everywhere.
const NOTCH_LINES = 3;
// An event this far from the one before it (or further) is a notch of its own. Closer events in one direction move
// proportionally fewer lines, at least one: deliberate scrolling at any pace moves no slower than isolated notches.
const NOTCH_GAP_MS = 100;
// Events closer than this arrived in one terminal read (the stdin parser hands them over within microseconds). Their
// own gaps say nothing about the hand's speed: the read's events share the gap before it.
const SAME_READ_MS = 1;
// The lines of every event inside one 60 Hz frame are painted as one scroll; together they move at most this many.
// A sustained flick moves about 16 a frame, so only events piled up behind a stall or in one read reach it.
const FRAME_MS = 1000 / 60;
const MAX_FRAME_LINES = 24;
// Lines beyond a frame's cap wait for the following frames; a flood never queues more than this many.
const MAX_PENDING_LINES = MAX_FRAME_LINES * 20;

// Several events closer than this belong to one physical notch (Ghostty emits them ~4 ms apart)
// or come from a high-resolution source. They move one line each and do not accelerate.
export const BURST_GAP_MS = 5;
// A pause longer than this ends a scroll gesture.
const GESTURE_GAP_MS = 200;
// Average notch gap that maps to one notch's lines per event. Faster notches scale up proportionally.
const REFERENCE_GAP_MS = 100;
const MAX_AUTO_LINES = 12;
// On a terminal that already sends one event per accelerated line (local macOS: Terminal.app sends about 120 events a
// second during a hard flick, 8 ms apart), one line per event trails the hand: crossing 2,000 rows took 18 s. Events at
// most this far apart in one direction form a flick run. 17 ms is one 60 Hz frame: Terminal.app's slowest flick events
// still land inside it.
const FLICK_GAP_MS = 17;
// The first events of a run move one line each, so a short, careful scroll at a medium pace stays precise.
const FLICK_RAMP_EVENTS = 3;
// Lines per event at one event per frame (`FLICK_GAP_MS`); denser events scale up in proportion to their rate.
const FLICK_BASE_LINES = 1.5;
// A run sustained this many events (about half a second at 120 per second) doubles its lines per event.
const FLICK_SUSTAIN_EVENTS = 60;
const MAX_FLICK_LINES = 8;

/**
 * Local macOS terminals receive wheel and trackpad deltas that the OS has already accelerated,
 * and they emit one event per line. Other platforms, and SSH sessions where the client platform
 * is unknown, usually send one event per wheel notch.
 */
function terminalAcceleratesWheel(): boolean {
	const env = process.env;
	return (
		process.platform === "darwin" &&
		env.SSH_CONNECTION === undefined &&
		env.SSH_CLIENT === undefined &&
		env.SSH_TTY === undefined
	);
}

/**
 * Converts wheel events into line counts.
 *
 * In `"auto"` mode an isolated event moves three lines on every terminal. On terminals that do not accelerate wheel
 * input, faster notches move more: notches 100 ms apart move 3 lines each, 50 ms apart 6, and 25 ms apart or faster
 * 12. On terminals that accelerate wheels themselves, events closer than a notch move proportionally fewer lines (at
 * least one), and a flick (a run of events a frame apart or closer) moves about 3 lines per event at 120 events a
 * second, rising to 6 as the flick lasts. Events of one terminal read share the gap before that read, and the events
 * inside one frame move at most `MAX_FRAME_LINES` together. A fixed line count always wins.
 */
export class WheelScrollAccelerator {
	private lines: WheelScrollLines;
	private readonly accelerate: boolean;
	private lastTime = Number.NEGATIVE_INFINITY;
	private lastDirection = 0;
	private averageGap: number | undefined;
	private carry = 0;
	private flickRun = 0;
	private flickGap: number | undefined;
	/** The gap before the read the last event came in, and how many events of that read came so far. */
	private readGap = Number.POSITIVE_INFINITY;
	private readEvents = 0;
	private frameStart = Number.NEGATIVE_INFINITY;
	private frameLines = 0;
	/** Lines the frame cap held back, to move in `pendingDirection` in following frames. */
	private pending = 0;
	private pendingDirection: -1 | 1 = 1;
	private drainTimer: NodeJS.Timeout | undefined;

	constructor(lines: WheelScrollLines = "auto", accelerate = !terminalAcceleratesWheel()) {
		this.lines = lines;
		this.accelerate = accelerate;
	}

	setLines(lines: WheelScrollLines): void {
		this.lines = lines;
		this.reset();
	}

	/**
	 * Return the line count for a wheel event in `direction` at time `now` (milliseconds): positive, or 0 in `"auto"`
	 * mode once the events of the current frame have moved `MAX_FRAME_LINES`.
	 */
	next(direction: -1 | 1, now: number): number {
		if (this.lines !== "auto") return Number.isFinite(this.lines) ? Math.max(1, Math.floor(this.lines)) : 1;
		const gap = now - this.lastTime;
		const sameRead = direction === this.lastDirection && gap < SAME_READ_MS;
		// The events of one read came together whatever the hand did: their pace is the gap before the read spread over
		// them. The first event of a read spreads it over as many events as the read before it had.
		let pace: number;
		if (sameRead) {
			this.readEvents++;
			pace = Math.min(this.readGap, NOTCH_GAP_MS) / this.readEvents;
		} else {
			pace = gap / Math.max(1, this.readEvents);
			this.readGap = gap;
			this.readEvents = 1;
		}
		const lines = this.accelerate ? this.notch(direction, now, gap) : this.flick(direction, now, gap, pace);
		if (direction !== this.pendingDirection) this.pending = 0;
		this.pendingDirection = direction;
		return this.limitFrame(lines + this.pending, now);
	}

	/**
	 * Move the lines the frame cap held back, as far as the frame at `now` allows. Returns the line count, to scroll in
	 * the direction of the last event.
	 */
	takePending(now: number): { direction: -1 | 1; lines: number } {
		return { direction: this.pendingDirection, lines: this.limitFrame(this.pending, now) };
	}

	/**
	 * Call `apply` once a frame with held-back lines until none remain. The timer never keeps the process alive;
	 * `clearPending` stops it.
	 */
	drainPending(apply: (direction: -1 | 1, lines: number) => void): void {
		if (this.pending === 0 || this.drainTimer) return;
		this.drainTimer = setTimeout(() => {
			this.drainTimer = undefined;
			const { direction, lines } = this.takePending(performance.now());
			if (lines > 0) apply(direction, lines);
			this.drainPending(apply);
		}, FRAME_MS);
		this.drainTimer.unref();
	}

	/** Drop held-back lines and stop the drain timer: on focus loss and when the screen stops. */
	clearPending(): void {
		this.pending = 0;
		if (this.drainTimer) clearTimeout(this.drainTimer);
		this.drainTimer = undefined;
	}

	/** Lines for an event on a terminal that sends one event per notch: three, more for fast spins. */
	private notch(direction: -1 | 1, now: number, gap: number): number {
		const sameGesture = direction === this.lastDirection && gap <= GESTURE_GAP_MS;
		this.lastTime = now;
		this.lastDirection = direction;
		if (!sameGesture) {
			this.averageGap = undefined;
			this.carry = 0;
			return NOTCH_LINES;
		}
		if (gap < BURST_GAP_MS) return 1;

		this.averageGap = this.averageGap === undefined ? gap : (this.averageGap + gap) / 2;
		const scale = Math.max(1, REFERENCE_GAP_MS / this.averageGap);
		return this.whole(Math.min(MAX_AUTO_LINES, NOTCH_LINES * scale));
	}

	/**
	 * Lines for an event on a terminal that accelerates wheels itself. An event that starts a run moves up to a notch's
	 * lines, in proportion to its gap; the first events of a run move one line each. Past them the count follows the
	 * run's velocity (its average event gap against one per frame) and how long it has lasted; a fractional part is
	 * carried to the next event.
	 */
	private flick(direction: -1 | 1, now: number, gap: number, pace: number): number {
		const sameDirection = direction === this.lastDirection;
		const dense = sameDirection && pace <= FLICK_GAP_MS;
		this.lastTime = now;
		this.lastDirection = direction;
		if (!dense) {
			this.flickRun = 0;
			this.flickGap = undefined;
			// A new direction or a pause starts afresh; a steady pace keeps its fraction.
			if (!sameDirection || gap >= NOTCH_GAP_MS) this.carry = 0;
			const lines = (NOTCH_LINES * Math.min(gap, NOTCH_GAP_MS)) / NOTCH_GAP_MS;
			if (lines > 1) return this.whole(lines);
			this.carry = 0;
			return 1;
		}
		if (++this.flickRun === 1) this.carry = 0;
		const clamped = Math.max(1, pace);
		this.flickGap = this.flickGap === undefined ? clamped : this.flickGap * 0.75 + clamped * 0.25;
		if (this.flickRun < FLICK_RAMP_EVENTS) return 1;
		const velocity = FLICK_GAP_MS / this.flickGap;
		const sustain = 1 + Math.min(1, (this.flickRun - FLICK_RAMP_EVENTS) / FLICK_SUSTAIN_EVENTS);
		return this.whole(Math.min(MAX_FLICK_LINES, Math.max(1, FLICK_BASE_LINES * velocity * sustain)));
	}

	/** The whole part of `lines` plus the carried fraction; the new fraction is carried on. */
	private whole(lines: number): number {
		const total = lines + this.carry;
		const whole = Math.floor(total);
		this.carry = total - whole;
		return whole;
	}

	private limitFrame(lines: number, now: number): number {
		if (now - this.frameStart >= FRAME_MS) {
			this.frameStart = now;
			this.frameLines = 0;
		}
		const allowed = Math.max(0, Math.min(lines, MAX_FRAME_LINES - this.frameLines));
		this.frameLines += allowed;
		this.pending = Math.min(MAX_PENDING_LINES, lines - allowed);
		return allowed;
	}

	private reset(): void {
		this.clearPending();
		this.flickRun = 0;
		this.flickGap = undefined;
		this.lastTime = Number.NEGATIVE_INFINITY;
		this.lastDirection = 0;
		this.averageGap = undefined;
		this.carry = 0;
		this.readGap = Number.POSITIVE_INFINITY;
		this.readEvents = 0;
		this.frameStart = Number.NEGATIVE_INFINITY;
		this.frameLines = 0;
	}
}
