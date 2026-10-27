/**
 * Spaces out background children that share a prompt prefix. A provider's prompt cache entry exists only once the
 * first response to a prefix starts, so siblings launched together each pay a full cache write. The first child of a
 * prefix starts at once; the others wait until its first reply starts streaming (the cache is then written) and read
 * it instead. The wait is bounded (`maxWaitMs`), ends early when the first child exits without replying, and gives
 * way to an abort, so a slow or failing first child never holds the others for long. Once a prefix is warm, later
 * children of it start at once until the cache entry would have lapsed (`warmForMs`).
 */

const MAX_WAIT_MS = 10_000;
/** Shorter than the shortest provider cache lifetime (5 minutes), so a lapsed entry is not assumed warm. */
const WARM_FOR_MS = 240_000;

const cancelled = () => new Error("Subagent cancelled");

interface Leader {
	released: Promise<void>;
	release: () => void;
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
	 * Runs `start` for a child of the prefix `key`: at once when it is the first of its prefix or the prefix is warm,
	 * otherwise after the first child's first reply began, at most `maxWaitMs` later. `start` receives `warm`, which
	 * the caller invokes when this child's first reply starts; it is a no-op for a child that is not the first.
	 * An abort while waiting rejects with a cancellation without starting anything.
	 */
	async run<T>(key: string, signal: AbortSignal | undefined, start: (warm: () => void) => Promise<T>): Promise<T> {
		const deadline = this.now() + this.maxWaitMs;
		for (;;) {
			if (signal?.aborted) throw cancelled();
			if ((this.warmUntil.get(key) ?? 0) > this.now()) return start(() => undefined);
			const leader = this.leaders.get(key);
			if (!leader) return this.lead(key, start);
			const left = deadline - this.now();
			if (left <= 0) return start(() => undefined);
			await waitFor(leader.released, left, signal);
		}
	}

	private async lead<T>(key: string, start: (warm: () => void) => Promise<T>): Promise<T> {
		let release = () => {};
		const released = new Promise<void>((resolve) => (release = resolve));
		const leader: Leader = { released, release };
		this.leaders.set(key, leader);
		// Followers wait at most this long after the first child started, however it goes.
		const timer = setTimeout(() => this.end(key, leader), this.maxWaitMs);
		timer.unref();
		try {
			return await start(() => {
				this.warmUntil.set(key, this.now() + this.warmForMs);
				this.end(key, leader);
			});
		} finally {
			clearTimeout(timer);
			this.end(key, leader);
		}
	}

	private end(key: string, leader: Leader): void {
		if (this.leaders.get(key) === leader) this.leaders.delete(key);
		leader.release();
	}
}

/** One per parent process: its children share the provider's cache. */
export const childStagger = new PrefixStagger();
