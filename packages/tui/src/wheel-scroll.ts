/** Lines moved per mouse-wheel event, or `"auto"` to accelerate fast wheel spins. */
export type WheelScrollLines = number | "auto";

// Several events closer than this belong to one physical notch (Ghostty emits them ~4 ms apart)
// or come from a high-resolution source. They move one line each and do not accelerate.
const BURST_GAP_MS = 5;
// A pause longer than this ends a scroll gesture.
const GESTURE_GAP_MS = 200;
// Average event gap that maps to one line per event. Faster events scale up proportionally.
const REFERENCE_GAP_MS = 100;
const MAX_AUTO_LINES = 6;
// On a terminal that already sends one event per accelerated line (local macOS: Terminal.app sends about 120 events a
// second during a hard flick, 8 ms apart), one line per event trails the hand: crossing 2,000 rows took 18 s. Events at
// most this far apart in one direction form a flick run; an event further apart than this is deliberate scrolling and
// moves one line. 17 ms is one 60 Hz frame: Terminal.app's slowest flick events still land inside it.
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
 * In `"auto"` mode on terminals that do not accelerate wheel input, the count follows event
 * velocity: an isolated notch moves one line, while a fast spin moves up to six lines per event.
 * For example, notches 100 ms apart move 1 line each, 50 ms apart move 2, and 20 ms apart move 5.
 * On terminals that accelerate wheels themselves, events more than a frame apart move one line each,
 * and a flick (a run of events a frame apart or closer) moves about 3 lines per event at 120 events a
 * second, rising to 6 as the flick lasts. A fixed line count always wins.
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

	constructor(lines: WheelScrollLines = "auto", accelerate = !terminalAcceleratesWheel()) {
		this.lines = lines;
		this.accelerate = accelerate;
	}

	setLines(lines: WheelScrollLines): void {
		this.lines = lines;
		this.reset();
	}

	/** Return the positive line count for a wheel event in `direction` at time `now` (milliseconds). */
	next(direction: -1 | 1, now: number): number {
		if (this.lines !== "auto") return Number.isFinite(this.lines) ? Math.max(1, Math.floor(this.lines)) : 1;
		if (!this.accelerate) return this.flick(direction, now);

		const gap = now - this.lastTime;
		const sameGesture = direction === this.lastDirection && gap <= GESTURE_GAP_MS;
		this.lastTime = now;
		this.lastDirection = direction;
		if (!sameGesture) {
			this.averageGap = undefined;
			this.carry = 0;
			return 1;
		}
		if (gap < BURST_GAP_MS) return 1;

		this.averageGap = this.averageGap === undefined ? gap : (this.averageGap + gap) / 2;
		const lines = Math.min(MAX_AUTO_LINES, Math.max(1, REFERENCE_GAP_MS / this.averageGap)) + this.carry;
		const whole = Math.floor(lines);
		this.carry = lines - whole;
		return whole;
	}

	/**
	 * Lines for an event on a terminal that accelerates wheels itself. An event that ends or starts a run moves one line,
	 * as do the first events of a run. Past them the count follows the run's velocity (its average event gap against
	 * one per frame) and how long it has lasted; a fractional part is carried to the next event.
	 */
	private flick(direction: -1 | 1, now: number): number {
		const gap = now - this.lastTime;
		const dense = direction === this.lastDirection && gap <= FLICK_GAP_MS;
		this.lastTime = now;
		this.lastDirection = direction;
		if (!dense) {
			this.flickRun = 0;
			this.flickGap = undefined;
			this.carry = 0;
			return 1;
		}
		this.flickRun++;
		// Terminals deliver events in bursts; a gap under a millisecond says nothing about the hand's speed.
		const sample = Math.max(1, gap);
		this.flickGap = this.flickGap === undefined ? sample : this.flickGap * 0.75 + sample * 0.25;
		if (this.flickRun < FLICK_RAMP_EVENTS) return 1;
		const velocity = FLICK_GAP_MS / this.flickGap;
		const sustain = 1 + Math.min(1, (this.flickRun - FLICK_RAMP_EVENTS) / FLICK_SUSTAIN_EVENTS);
		const lines = Math.min(MAX_FLICK_LINES, Math.max(1, FLICK_BASE_LINES * velocity * sustain)) + this.carry;
		const whole = Math.floor(lines);
		this.carry = lines - whole;
		return whole;
	}

	private reset(): void {
		this.flickRun = 0;
		this.flickGap = undefined;
		this.lastTime = Number.NEGATIVE_INFINITY;
		this.lastDirection = 0;
		this.averageGap = undefined;
		this.carry = 0;
	}
}
