/**
 * q(t): the chance that an idle refresh is used, from idle gaps (a finished run's last reply to the next request). A
 * session uses its own gaps once it has enough (`octocode/compaction/cache.ts`); before that, the gaps of every
 * session on this machine, pooled and persisted, with a measured seed as the prior.
 */

/** Gaps that outlast the current idle age needed before they are trusted over the prior (fewer are noise). */
const MIN_IDLE_SAMPLES = 5;
/** The pool keeps this many of the most recent gaps. */
const MAX_POOLED_GAPS = 500;
/** How many observations the seed counts as, at most: real gaps outweigh it once they are more. */
const PRIOR_WEIGHT = 20;

/**
 * Measured q at the first idle refresh (idle age 0.9 × the lifetime), per lifetime in seconds: of the main-session gaps
 * longer than 0.9 × T, the share that ended within (T, 1.9 × T], as `idleContinuation` counts them. 1,960 gaps from
 * this machine's transcripts, 2026-11-04 to 11-19 (children excluded; they follow their coordinator's mail).
 */
const SEED: ReadonlyArray<{ ttlSeconds: number; used: number; survivors: number }> = [
	{ ttlSeconds: 300, used: 131, survivors: 316 },
	{ ttlSeconds: 1800, used: 20, survivors: 47 },
	{ ttlSeconds: 3600, used: 13, survivors: 21 },
];

/**
 * q(t) from `gaps`: of the gaps that lasted longer than `idleMs`, the share that ended after a tenth of the lifetime
 * (sooner, the entry is still warm without the refresh) and within the lifetime (later, the refreshed entry has expired
 * too). Undefined with fewer than `MIN_IDLE_SAMPLES` such gaps.
 */
export function idleContinuation(gaps: readonly number[], idleMs: number, ttlMs: number): number | undefined {
	const { used, survivors } = countContinuations(gaps, idleMs, ttlMs);
	return survivors < MIN_IDLE_SAMPLES ? undefined : used / survivors;
}

function countContinuations(gaps: readonly number[], idleMs: number, ttlMs: number) {
	let used = 0;
	let survivors = 0;
	for (const gap of gaps) {
		if (gap <= idleMs) continue;
		survivors++;
		if (gap > idleMs + ttlMs / 10 && gap <= idleMs + ttlMs) used++;
	}
	return { used, survivors };
}

/** The seed for the measured lifetime nearest `ttlMs` (by ratio). */
function seedFor(ttlMs: number): { q: number; weight: number } {
	const distance = (seconds: number) => Math.abs(Math.log((seconds * 1000) / Math.max(ttlMs, 1)));
	const nearest = SEED.reduce((best, entry) => (distance(entry.ttlSeconds) < distance(best.ttlSeconds) ? entry : best));
	return { q: nearest.used / nearest.survivors, weight: Math.min(PRIOR_WEIGHT, nearest.survivors) };
}

/** Where pooled gaps live: read the current list; append one gap and return the list as stored. */
export interface IdleGapStore {
	read(): number[];
	append(gapMs: number, keep: number): number[];
}

const validGap = (gap: unknown): gap is number => typeof gap === "number" && Number.isFinite(gap) && gap >= 0;

/**
 * Pooled idle gaps with the measured seed as the prior. Without a store (tests, a subagent) only gaps recorded in this
 * process join the seed. A store failure is reported to `onError` and the pool keeps working from memory: losing a
 * statistic must not stop a request.
 */
export class IdleContinuationPool {
	private gaps: number[] | undefined;
	private readonly store: IdleGapStore | undefined;
	private readonly onError: (error: unknown) => void;

	constructor(store?: IdleGapStore, onError: (error: unknown) => void = () => {}) {
		this.store = store;
		this.onError = onError;
	}

	private loaded(): number[] {
		if (this.gaps) return this.gaps;
		this.gaps = [];
		if (!this.store) return this.gaps;
		try {
			this.gaps = this.store.read().filter(validGap).slice(-MAX_POOLED_GAPS);
		} catch (error) {
			this.onError(error);
		}
		return this.gaps;
	}

	/** q at idle age `idleMs` for an entry living `ttlMs`: the pooled gaps, pulled toward the seed while they are few. */
	probability(idleMs: number, ttlMs: number): number {
		const { used, survivors } = countContinuations(this.loaded(), idleMs, ttlMs);
		const seed = seedFor(ttlMs);
		return (used + seed.q * seed.weight) / (survivors + seed.weight);
	}

	/** Adds one idle gap to the pool (and the store). */
	record(gapMs: number): void {
		if (!validGap(gapMs)) return;
		const gaps = this.loaded();
		gaps.push(gapMs);
		if (gaps.length > MAX_POOLED_GAPS) gaps.splice(0, gaps.length - MAX_POOLED_GAPS);
		if (!this.store) return;
		try {
			this.gaps = this.store.append(gapMs, MAX_POOLED_GAPS).filter(validGap);
		} catch (error) {
			this.onError(error);
		}
	}
}
