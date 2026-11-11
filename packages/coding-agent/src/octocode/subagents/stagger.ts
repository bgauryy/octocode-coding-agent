/**
 * Spaces out the first model requests of background children that share a prompt prefix. A provider's prompt cache
 * entry exists only once the first response to a prefix starts, so siblings that ask together each pay a full cache
 * write. Every child starts its process at once, so the siblings boot while the first child's request runs; the first
 * child of a prefix sends its task at once, the others wait (`ready`) until its first reply starts streaming (the cache
 * is then written) and read it instead. The wait is bounded (`maxWaitMs`), ends early when the first child exits
 * without replying, and gives way to an abort, so a slow or failing first child never holds the others for long. Once
 * a prefix is warm, later children of it send at once until the cache entry would have lapsed (`warmForMs`).
 */

const MAX_WAIT_MS = 10_000;
/** When a child's own cache lifetime is unknown: shorter than the shortest provider lifetime (5 minutes). */
const WARM_FOR_MS = 240_000;

const cancelled = () => new Error("Subagent cancelled");

interface Leader {
	released: Promise<void>;
	release: () => void;
	timer: NodeJS.Timeout;
}

/** What a child of a prefix gets: `warm` when its first reply starts, `ready` to await before its first request. */
export interface StaggerTurn {
	/** This child's first reply started: its siblings may send. A no-op for a child that is not the first. */
	warm: () => void;
	/** Resolves when this child may send its first request; rejects with a cancellation on abort. */
	ready: () => Promise<void>;
}

/** Resolves when `promise` does, after `ms`, or on abort (rejecting with a cancellation). */
function waitFor(promise: Promise<void>, ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const settle = (error?: Error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve();
		};
		const onAbort = () => settle(cancelled());
		const timer = setTimeout(settle, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
		void promise.then(() => settle());
	});
}

export class PrefixStagger {
	private readonly leaders = new Map<string, Leader>();
	private readonly warmUntil = new Map<string, number>();

	private readonly maxWaitMs: number;
	private readonly warmForMs: number;
	private readonly now: () => number;

	constructor(maxWaitMs = MAX_WAIT_MS, warmForMs = WARM_FOR_MS, now: () => number = Date.now) {
		this.maxWaitMs = maxWaitMs;
		this.warmForMs = warmForMs;
		this.now = now;
	}

	/**
	 * Runs `start` for a child of the prefix `key` at once. The child awaits `ready` before its first request: that
	 * resolves at once when it is the first of its prefix or the prefix is warm, otherwise after the first child's first
	 * reply began, at most `maxWaitMs` after this call. When the first child ends without a reply, the waiting child that
	 * asks next becomes the first. An abort before the call rejects without starting anything; one during the wait rejects
	 * `ready`. `warmForMs` is how long the entry this child writes stays warm: its resolved cache lifetime, shortened a
	 * little for the clock skew of a late sibling.
	 */
	async run<T>(
		key: string,
		signal: AbortSignal | undefined,
		start: (turn: StaggerTurn) => Promise<T>,
		warmForMs = this.warmForMs,
	): Promise<T> {
		if (signal?.aborted) throw cancelled();
		const deadline = this.now() + this.maxWaitMs;
		let mine: Leader | undefined;
		const isWarm = () => (this.warmUntil.get(key) ?? 0) > this.now();
		// Taken now, not when `ready` is first awaited: siblings started right after this one must find it.
		if (!isWarm() && !this.leaders.has(key)) mine = this.lead(key);
		const warm = () => {
			if (!mine) return;
			this.warmUntil.set(key, this.now() + warmForMs);
			this.end(key, mine);
		};
		const ready = async () => {
			for (;;) {
				if (signal?.aborted) throw cancelled();
				if (mine || isWarm()) return;
				const leader = this.leaders.get(key);
				if (!leader) {
					mine = this.lead(key);
					return;
				}
				const left = deadline - this.now();
				if (left <= 0) return;
				await waitFor(leader.released, left, signal);
			}
		};
		try {
			return await start({ warm, ready });
		} finally {
			if (mine) this.end(key, mine);
		}
	}

	private lead(key: string): Leader {
		let release = () => {};
		const released = new Promise<void>((resolve) => (release = resolve));
		// Followers wait at most this long after the first child started, however it goes.
		const timer = setTimeout(() => this.end(key, leader), this.maxWaitMs);
		timer.unref();
		const leader: Leader = { released, release, timer };
		this.leaders.set(key, leader);
		return leader;
	}

	private end(key: string, leader: Leader): void {
		clearTimeout(leader.timer);
		if (this.leaders.get(key) === leader) this.leaders.delete(key);
		leader.release();
	}
}

/** One per parent process: its children share the provider's cache. */
export const childStagger = new PrefixStagger();

/**
 * Launches of one child of `prefix` through the stagger: `staggeredLaunch(prefix, ttl, launch)(update)` is the launch
 * function for one run, which runs `launch` at once with its turn (the warm signal, and the gate its first request
 * awaits). Foreground and background launches both go through it, so parallel siblings of either kind write their
 * prefix once.
 */
export function staggeredLaunch<T, U>(
	prefix: string,
	ttlMs: number | undefined,
	launch: (signal: AbortSignal | undefined, update: U | undefined, turn: StaggerTurn) => Promise<T>,
): (update?: U) => (signal: AbortSignal | undefined) => Promise<T> {
	// A sibling that starts right before the entry lapses would still miss: keep a tenth as margin.
	const warmForMs = ttlMs === undefined ? undefined : Math.floor(ttlMs * 0.9);
	return (update) => (signal) => childStagger.run(prefix, signal, (turn) => launch(signal, update, turn), warmForMs);
}
