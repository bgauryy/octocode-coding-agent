/** Quiet time after the last resize event before the one frame at the final size. */
const RESIZE_DEBOUNCE_MS = 12;

/**
 * Collapses a burst of terminal resize events into one callback after the burst ends; each event
 * restarts the wait, so the callback sees the final size.
 */
export class ResizeDebounce {
	private readonly fire: () => void;
	private readonly delayMs: number;
	private timer: NodeJS.Timeout | undefined;

	constructor(fire: () => void, delayMs = RESIZE_DEBOUNCE_MS) {
		this.fire = fire;
		this.delayMs = delayMs;
	}

	trigger(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.fire();
		}, this.delayMs);
		this.timer.unref();
	}

	stop(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}
