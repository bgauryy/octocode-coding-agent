/**
 * Stalled work: an ongoing item a running child serves whose progress (a note, step or claim on the item, a file the
 * child changed, a job for it) stopped for `STALL_MINUTES`. Code only: no model judges it. Each stall is told once; a
 * second stall of the same item asks for a re-plan; after that the item raises nothing.
 */

/** Minutes without progress before running work counts as stalled (owner decision, RFC Q2). */
export const STALL_MINUTES = 20;

/** One delegated item and when its work last moved. */
export interface StallSubject {
	ref: string;
	/** The child working it. */
	agent: string;
	lastProgressAt: number;
}

/** What to tell: `stall` the first time, `replan` the second. */
export interface StallAlert {
	ref: string;
	agent: string;
	level: "stall" | "replan";
	/** Whole minutes since its last progress. */
	minutes: number;
}

/** Remembers per item which silence was told and how many stalls it had. */
export class StallTracker {
	private readonly told = new Map<string, { at: number; count: number }>();
	private readonly minutes: number;

	constructor(minutes = STALL_MINUTES) {
		this.minutes = minutes;
	}

	/**
	 * The alerts due at `now`. A silence is told once: the same `lastProgressAt` raises nothing again, and new progress
	 * re-arms the item. An item no longer among `subjects` (done, released, its child ended) is forgotten.
	 */
	check(subjects: readonly StallSubject[], now: number): StallAlert[] {
		const current = new Set(subjects.map((subject) => subject.ref));
		for (const ref of this.told.keys()) if (!current.has(ref)) this.told.delete(ref);
		const alerts: StallAlert[] = [];
		for (const { ref, agent, lastProgressAt } of subjects) {
			const silent = now - lastProgressAt;
			if (silent < this.minutes * 60_000) continue;
			const entry = this.told.get(ref);
			if (entry?.at === lastProgressAt) continue;
			const count = (entry?.count ?? 0) + 1;
			this.told.set(ref, { at: lastProgressAt, count });
			if (count > 2) continue;
			alerts.push({ ref, agent, level: count === 1 ? "stall" : "replan", minutes: Math.floor(silent / 60_000) });
		}
		return alerts;
	}
}
