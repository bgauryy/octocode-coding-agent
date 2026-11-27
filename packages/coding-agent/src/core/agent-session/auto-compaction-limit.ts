/** Progressive retry intervals after consecutive trips for one model key. */
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
/** Failures in a row, for one session and model, that turn automatic compaction off. */
const LIMIT = 3;

interface LimitState {
	count: number;
	trips: number;
	lastFailureAt: number;
	noticed: boolean;
}

const backoffMs = (trips: number): number =>
	RETRY_BACKOFF_MS[Math.min(Math.max(0, trips - 1), RETRY_BACKOFF_MS.length - 1)];

/** The key one session's compaction attempts on one model share: manual and automatic runs count against the same limit. */
export const compactionAttemptKey = (sessionId: string, model: { provider: string; id: string } | undefined): string =>
	JSON.stringify([sessionId, model?.provider, model?.id]);

/**
 * The guard on automatic compaction: three failures in a row for one session and model turn it off with progressive
 * backoff (1m, 5m, 15m, 60m) until a compaction succeeds. Tracked per model key so a temporary fallback or switch does
 * not erase another model's trip state.
 */
export class AutoCompactionLimit {
	readonly #states = new Map<string, LimitState>();

	#state(key: string): LimitState {
		let state = this.#states.get(key);
		if (!state) {
			state = { count: 0, trips: 0, lastFailureAt: 0, noticed: false };
			this.#states.set(key, state);
		}
		return state;
	}

	/**
	 * Whether an attempt may run for `key`: "run", or else "notice" to say why not or "quiet" when that was already said.
	 */
	check(key: string, reason: "overflow" | "threshold"): "run" | "notice" | "quiet" {
		const state = this.#state(key);
		if (state.count < LIMIT) return "run";
		if (Date.now() - state.lastFailureAt >= backoffMs(state.trips)) {
			state.count = LIMIT - 1;
			state.noticed = false;
			return "run";
		}
		if (reason === "threshold" && state.noticed) return "quiet";
		state.noticed = true;
		return "notice";
	}

	failed(key: string): void {
		const state = this.#state(key);
		state.count += 1;
		if (state.count >= LIMIT) state.trips += 1;
		state.lastFailureAt = Date.now();
	}

	succeeded(key: string): void {
		this.#states.delete(key);
	}
}
