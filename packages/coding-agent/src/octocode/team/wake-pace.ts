/** The least time between two turns that peers start in an idle agent: mail that arrives meanwhile joins the next one. */
export const WAKE_INTERVAL_MS = 30_000;
/** Peer-started turns an idle agent accepts in one `WAKE_WINDOW_MS`: a ceiling for a chatty pair that never idles long enough for the interval to bind. */
export const WAKES_PER_WINDOW = 6;
/** The span `WAKES_PER_WINDOW` counts over: long enough that the budget is a few turns, short enough to recover within one task. */
export const WAKE_WINDOW_MS = 10 * 60_000;

interface RecordedWake {
	id: number;
	at: number;
	senders: readonly string[];
}

/**
 * When an idle agent may be started by another agent's message. Pure bookkeeping over an injected clock: the recipient
 * asks `allows` before it hands over a waking batch and `record`s the turn that handing started. The user, an interrupt,
 * a direct child's blocking question and the answer to a question the agent asked are never paced (`Delivery`).
 * `WAKE_INTERVAL_MS` spaces peer-started turns overall; `WAKES_PER_WINDOW` caps each sender independently so one chatty
 * peer cannot starve unrelated peers.
 */
export class WakePace {
	private starts: RecordedWake[] = [];
	private nextId = 1;
	private readonly now: () => number;
	constructor(now: () => number = () => Date.now()) {
		this.now = now;
	}

	/** Whether a peer batch from `senders` may start a turn now: global interval passed and at least one sender has window budget. */
	allows(senders: readonly string[] = [""]): boolean {
		const now = this.now();
		this.forget(now);
		const last = this.starts.at(-1)?.at;
		if (last !== undefined && now - last < WAKE_INTERVAL_MS) return false;
		const keys = senders.length > 0 ? senders : [""];
		return keys.some((sender) => this.senderCount(sender) < WAKES_PER_WINDOW);
	}

	/** A peer-started turn began now; the returned id names it for `undo`. */
	record(senders: readonly string[] = [""]): number {
		const now = this.now();
		this.forget(now);
		const keys = senders.length > 0 ? [...new Set(senders)] : [""];
		const allowed = keys.filter((sender) => this.senderCount(sender) < WAKES_PER_WINDOW);
		const id = this.nextId++;
		this.starts.push({ id, at: now, senders: allowed.length > 0 ? allowed : keys });
		return id;
	}

	/** The turn recorded as `id` never ran (Octocode refused the handoff): it does not count. */
	undo(id: number): void {
		const index = this.starts.findIndex((entry) => entry.id === id);
		if (index >= 0) this.starts.splice(index, 1);
	}

	/** Forgets every turn (the agent left the team). */
	reset(): void {
		this.starts = [];
	}

	private senderCount(sender: string): number {
		let count = 0;
		for (const entry of this.starts) if (entry.senders.includes(sender)) count++;
		return count;
	}

	/** Drops turns older than the window, and any dated after `now` (the clock was set back). */
	private forget(now: number): void {
		this.starts = this.starts.filter((entry) => entry.at <= now && now - entry.at < WAKE_WINDOW_MS);
	}
}
