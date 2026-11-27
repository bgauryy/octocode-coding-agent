/** Quiet time after a lone resize event before the one frame at the new size. */
const RESIZE_DEBOUNCE_MS = 12;
/**
 * Quiet time while the size keeps changing (a window drag): a frame at a new width renders the whole transcript again,
 * so a drag repaints when it pauses, not at every step.
 */
const RESIZE_BURST_DEBOUNCE_MS = 80;
/** A drag that never pauses still repaints this often. */
const RESIZE_BURST_MAX_WAIT_MS = 250;

export interface ResizeDebounceOptions {
	delayMs?: number;
	burstDelayMs?: number;
	maxWaitMs?: number;
}

/**
 * Collapses terminal resize events into frames at the latest size. The first event after a quiet spell fires after a
 * short wait, so a resize answers quickly even when more events follow; later events of the burst restart the longer
 * burst wait, and a burst that never pauses still fires once per `maxWaitMs`.
 */
export class ResizeDebounce {
	private readonly fire: () => void;
	private readonly delayMs: number;
	private readonly burstDelayMs: number;
	private readonly maxWaitMs: number;
	private timer: NodeJS.Timeout | undefined;
	private lastEventAt: number | undefined;
	/** When the current burst started, or when it last fired: the max wait counts from here. */
	private windowStart = 0;
	/** The burst's first frame has not fired yet: it keeps its short deadline. */
	private leading = false;

	constructor(fire: () => void, options: ResizeDebounceOptions = {}) {
		this.fire = fire;
		this.delayMs = options.delayMs ?? RESIZE_DEBOUNCE_MS;
		this.burstDelayMs = options.burstDelayMs ?? RESIZE_BURST_DEBOUNCE_MS;
		this.maxWaitMs = options.maxWaitMs ?? RESIZE_BURST_MAX_WAIT_MS;
	}

	/** A resize event is waiting for its frame: the terminal's size has not settled. */
	get pending(): boolean {
		return this.timer !== undefined;
	}

	/** Settle a waiting resize now; returns whether one was waiting. The caller paints the frame. */
	flush(): boolean {
		if (!this.timer) return false;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.windowStart = Date.now();
		this.leading = false;
		return true;
	}

	trigger(): void {
		const now = Date.now();
		const inBurst = this.lastEventAt !== undefined && now - this.lastEventAt < this.burstDelayMs;
		this.lastEventAt = now;
		if (!inBurst) {
			this.windowStart = now;
			this.leading = true;
		}
		const deadline = this.leading
			? this.windowStart + this.delayMs
			: Math.min(now + this.burstDelayMs, this.windowStart + this.maxWaitMs);
		const delay = Math.max(0, deadline - now);
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.flush();
			this.fire();
		}, delay);
		this.timer.unref();
	}

	stop(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.lastEventAt = undefined;
	}
}
