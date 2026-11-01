/** The least time between two turns that peers start in an idle agent: mail that arrives meanwhile joins the next one. */
export const WAKE_INTERVAL_MS = 30_000;
/** Peer-started turns an idle agent accepts in one `WAKE_WINDOW_MS`: a ceiling for a chatty pair that never idles long enough for the interval to bind. */
export const WAKES_PER_WINDOW = 6;
/** The span `WAKES_PER_WINDOW` counts over: long enough that the budget is a few turns, short enough to recover within one task. */
export const WAKE_WINDOW_MS = 10 * 60_000;

/**
 * When an idle agent may be started by another agent's message. Pure bookkeeping over an injected clock: the recipient
 * asks `allows` before it hands over a waking batch and `record`s the turn that handing started. The user, an interrupt and
 * the answer to a question the agent asked are never paced (`Delivery`); this only bounds how often peers can start turns.
 */
export class WakePace {
	private starts: number[] = [];
	private readonly now: () => number;
	constructor(now: () => number = () => Date.now()) {
		this.now = now;
	}

	/** Whether a peer may start a turn now: the interval since the last one passed and the window still has budget. */
	allows(): boolean {
		const now = this.now();
		this.forget(now);
		const last = this.starts.at(-1);
		return (last === undefined || now - last >= WAKE_INTERVAL_MS) && this.starts.length < WAKES_PER_WINDOW;
	}

	/** A peer-started turn began now; the returned time names it for `undo`. */
	record(): number {
		const now = this.now();
		this.forget(now);
		this.starts.push(now);
		return now;
	}

	/** The turn recorded at `start` never ran (Octocode refused the handoff): it does not count. */
	undo(start: number): void {
		const index = this.starts.indexOf(start);
		if (index >= 0) this.starts.splice(index, 1);
	}

	/** Forgets every turn (the agent left the team). */
	reset(): void {
		this.starts = [];
	}

	/** Drops turns older than the window, and any dated after `now` (the clock was set back). */
	private forget(now: number): void {
		this.starts = this.starts.filter((start) => start <= now && now - start < WAKE_WINDOW_MS);
	}
}
