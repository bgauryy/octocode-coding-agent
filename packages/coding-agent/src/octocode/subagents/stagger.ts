import { type Api, type Model, resolveModelCapabilities, type SimpleStreamOptions } from "@octocodeai/octocode-ai";
import { resolveCacheRetention } from "@octocodeai/octocode-ai/utils/cache-policy";

/**
 * Spaces out the first model requests of children that share a prompt prefix, where that saves money. A provider's prompt
 * cache entry exists only once the first response to a prefix starts, so siblings that ask together each pay for the
 * whole prefix. Every child starts its process at once, so the siblings boot while the first child's request runs; the
 * first child of a prefix sends its task at once, the others wait (`ready`) until its first reply starts streaming (the
 * cache is then written) and read it instead. No timer bounds the wait: it lasts while the first child is alive and
 * working toward that reply, and ends when its process exits (a crash, a retried start), when its run ends, or on an
 * abort. Once a prefix is warm, later children of it send at once until the cache entry would have lapsed (`warmForMs`).
 * A model where reading the cache costs no less than writing it, or a request that cannot hit a cache, gets no wait at
 * all (`staggerPays`).
 */

/** When a child's own cache lifetime is unknown: shorter than the shortest provider lifetime (5 minutes). */
const WARM_FOR_MS = 240_000;

const cancelled = () => new Error("Subagent cancelled");

interface Leader {
	released: Promise<void>;
	release: () => void;
}

/** What a child of a prefix gets: `warm` when its first reply starts, `ready` to await before its first request. */
export interface StaggerTurn {
	/** This child's first reply started: its siblings may send. A no-op for a child that is not the first. */
	warm: () => void;
	/** Resolves when this child may send its first request; rejects with a cancellation on abort. */
	ready: () => Promise<void>;
	/**
	 * This child's process exited (or failed to start) before its first reply: its siblings stop waiting for it, and the
	 * next one to ask leads. A retried start waits like any sibling. A no-op for a child that is not the first.
	 */
	lost: () => void;
}

/** Resolves when `promise` does; rejects with a cancellation when either signal aborts. */
function waitFor(promise: Promise<void>, signal: AbortSignal | undefined, ended: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			signal?.removeEventListener("abort", onAbort);
			ended.removeEventListener("abort", onAbort);
			reject(cancelled());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		ended.addEventListener("abort", onAbort, { once: true });
		void promise.then(() => {
			signal?.removeEventListener("abort", onAbort);
			ended.removeEventListener("abort", onAbort);
			resolve();
		});
	});
}

/**
 * Whether siblings that wait for the first child's cache entry pay less than siblings that each write it: the model's
 * prices make a cache read cheaper than the request that writes the entry (its cache-write price, else its input price),
 * the request may hit a cache (`cacheRetention` is not `none`) and the provider has a cache at all. A model whose cache
 * prices are unknown (absent or both zero) gets no wait: it would cost time and save nothing that can be shown.
 */
export function staggerPays(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
	// A model entry without prices (a hand-written one) is unknown: no wait.
	const cost: Partial<Model<Api>["cost"]> | undefined = model.cost;
	const input = cost?.input ?? 0;
	const cacheRead = cost?.cacheRead ?? 0;
	const cacheWrite = cost?.cacheWrite ?? 0;
	if (!(cacheRead > 0 || cacheWrite > 0)) return false;
	const writing = cacheWrite > 0 ? cacheWrite : input;
	if (!(cacheRead < writing)) return false;
	if (resolveCacheRetention(options?.cacheRetention, options?.env) === "none") return false;
	return resolveModelCapabilities(model, options?.env).cache.mechanism !== "none";
}

export class PrefixStagger {
	private readonly leaders = new Map<string, Leader>();
	private readonly warmUntil = new Map<string, number>();

	private readonly warmForMs: number;
	private readonly now: () => number;

	constructor(warmForMs = WARM_FOR_MS, now: () => number = Date.now) {
		this.warmForMs = warmForMs;
		this.now = now;
	}

	/**
	 * Runs `start` for a child of the prefix `key` at once. The child awaits `ready` before its first request: that
	 * resolves at once when it is the first of its prefix or the prefix is warm, otherwise after the first child's first
	 * reply began, or once that child is lost (`lost`) or its run ended: the waiting child that asks next becomes the
	 * first. An abort before the call rejects without starting anything; one during the wait rejects `ready`, and so does
	 * the end of this run: a run that ended never leads. `warmForMs`
	 * is how long the entry this child writes stays warm: its resolved cache lifetime, shortened a little for the clock
	 * skew of a late sibling.
	 */
	async run<T>(
		key: string,
		signal: AbortSignal | undefined,
		start: (turn: StaggerTurn) => Promise<T>,
		warmForMs = this.warmForMs,
	): Promise<T> {
		if (signal?.aborted) throw cancelled();
		let mine: Leader | undefined;
		// Aborted when this run ends: a `ready` still pending then rejects, and no later wake makes this run a leader.
		const ended = new AbortController();
		const isWarm = () => (this.warmUntil.get(key) ?? 0) > this.now();
		// Taken now, not when `ready` is first awaited: siblings started right after this one must find it.
		if (!isWarm() && !this.leaders.has(key)) mine = this.lead(key);
		const warm = () => {
			if (!mine) return;
			this.warmUntil.set(key, this.now() + warmForMs);
			this.end(key, mine);
		};
		const lost = () => {
			if (!mine) return;
			this.end(key, mine);
			mine = undefined;
		};
		const ready = async () => {
			for (;;) {
				if (signal?.aborted || ended.signal.aborted) throw cancelled();
				if (mine || isWarm()) return;
				const leader = this.leaders.get(key);
				if (!leader) {
					mine = this.lead(key);
					return;
				}
				await waitFor(leader.released, signal, ended.signal);
			}
		};
		try {
			return await start({ warm, ready, lost });
		} finally {
			// Every end (a result, a failure, an abort): siblings stop waiting for this run, and its own wait ends.
			ended.abort();
			if (mine) this.end(key, mine);
			mine = undefined;
		}
	}

	private lead(key: string): Leader {
		let release = () => {};
		const released = new Promise<void>((resolve) => (release = resolve));
		const leader: Leader = { released, release };
		this.leaders.set(key, leader);
		return leader;
	}

	private end(key: string, leader: Leader): void {
		if (this.leaders.get(key) === leader) this.leaders.delete(key);
		leader.release();
	}
}

/** One per parent process: its children share the provider's cache. */
export const childStagger = new PrefixStagger();

const unstaggered = (signal: AbortSignal | undefined): StaggerTurn => ({
	warm: () => undefined,
	lost: () => undefined,
	ready: async () => {
		if (signal?.aborted) throw cancelled();
	},
});

/**
 * Launches of one child of `prefix` through the stagger: `staggeredLaunch(prefix, ttl, launch, pays)(update)` is the
 * launch function for one run, which runs `launch` at once with its turn (the warm signal, and the gate its first request
 * awaits). Foreground and background launches both go through it, so parallel siblings of either kind write their
 * prefix once. Without `pays` (`staggerPays`) the turn never waits.
 */
export function staggeredLaunch<T, U>(
	prefix: string,
	ttlMs: number | undefined,
	launch: (signal: AbortSignal | undefined, update: U | undefined, turn: StaggerTurn) => Promise<T>,
	pays: boolean,
): (update?: U) => (signal: AbortSignal | undefined) => Promise<T> {
	// A sibling that starts right before the entry lapses would still miss: keep a tenth as margin.
	const warmForMs = ttlMs === undefined ? undefined : Math.floor(ttlMs * 0.9);
	return (update) => async (signal) => {
		if (pays) return childStagger.run(prefix, signal, (turn) => launch(signal, update, turn), warmForMs);
		if (signal?.aborted) throw cancelled();
		return launch(signal, update, unstaggered(signal));
	};
}
