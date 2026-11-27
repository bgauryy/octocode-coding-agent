import { isStaleSessionError } from "../../shared/util.ts";
import { attend } from "./attend.ts";

/**
 * Waiting this long for an early summary means it bought little: the request was sent shortly before the threshold so
 * the compaction would find it written, and a compaction that still holds the turn this long is close to one that
 * requests its own summary (a summary request takes tens of seconds; under ten seconds the turn barely pauses).
 */
export const LONG_PREWARM_WAIT_MS = 10_000;

/** What went wrong in one compaction cycle: its `value` in the ledger is the code, `threshold` what it was measured against. */
const PREWARM_OUTCOMES = {
	/** The early summary's request failed or returned nothing usable: billed for nothing. */
	failed: 1,
	/** The early summary was written but the compaction did not take it. */
	discarded: 2,
	/** A newer prewarm stopped the request of the one before. */
	replaced: 3,
	/** The threshold compaction waited `LONG_PREWARM_WAIT_MS` or more on the early summary. */
	"long wait": 4,
	/** The context crossed the threshold with no prewarm planned in this cycle. */
	"no prewarm": 5,
} as const;

export type PrewarmOutcome = keyof typeof PREWARM_OUTCOMES;

/** Where the user sees the alert once; a closed UI is not told. */
type Notify = (text: string) => void;

const TEXT: Record<PrewarmOutcome, (seconds: number) => string> = {
	failed: () => "The early compaction summary failed; the compaction will request its own.",
	discarded: () => "The early compaction summary was discarded unused.",
	replaced: () => "A newer early compaction summary replaced the one already requested.",
	"long wait": (seconds) => `The compaction still waited ${seconds} s for its early summary.`,
	"no prewarm": () => "The context reached the compaction threshold without an early summary.",
};

/**
 * The compaction-prewarm rule of one session. A cycle runs from one successful compaction (or the session start) to the
 * next; the first outcome in it that wasted the early summary or its point is alerted, the rest of the cycle stays
 * quiet. The model cannot act on it, so the alert only reaches the ledger (hook, room) and the user, once.
 */
export class PrewarmWatch {
	private planned = false;
	private alerted = false;
	private notify: Notify | undefined;
	private readonly api: object;

	constructor(api: object) {
		this.api = api;
	}

	/** A new session: where to show the alert (none without a UI), and a fresh cycle. */
	start(notify: Notify | undefined): void {
		this.notify = notify;
		this.compacted();
	}

	/** The session planned a prewarm in this cycle (whether or not its request was sent). */
	plan(): void {
		this.planned = true;
	}

	/** A threshold compaction began: with no prewarm planned in this cycle, its summary holds the whole turn. */
	threshold(): void {
		if (!this.planned) this.alert("no prewarm");
	}

	/** The threshold compaction took the early summary after waiting `waitedMs` for it. */
	waited(waitedMs: number): void {
		if (waitedMs >= LONG_PREWARM_WAIT_MS) this.alert("long wait", waitedMs);
	}

	/** The early summary was billed for nothing. */
	wasted(outcome: "failed" | "discarded" | "replaced"): void {
		this.alert(outcome);
	}

	/** A compaction succeeded: the next cycle may alert again. */
	compacted(): void {
		this.planned = false;
		this.alerted = false;
	}

	private alert(outcome: PrewarmOutcome, waitedMs = 0): void {
		if (this.alerted) return;
		this.alerted = true;
		const seconds = Math.round(waitedMs / 1000);
		void attend(
			this.api,
			{
				rule: "compaction-prewarm",
				value: outcome === "long wait" ? seconds : PREWARM_OUTCOMES[outcome],
				threshold: outcome === "long wait" ? LONG_PREWARM_WAIT_MS / 1000 : 0,
				subject: outcome,
			},
			undefined,
			{ how: "ledger" },
		);
		try {
			this.notify?.(TEXT[outcome](seconds));
		} catch (error) {
			if (!isStaleSessionError(error)) throw error;
		}
	}
}

const watches = new WeakMap<object, PrewarmWatch>();

/** The session's prewarm watch, keyed by its feature API like the ledger; created on first use. */
export function prewarmWatchOf(api: object): PrewarmWatch {
	let watch = watches.get(api);
	if (!watch) {
		watch = new PrewarmWatch(api);
		watches.set(api, watch);
	}
	return watch;
}
