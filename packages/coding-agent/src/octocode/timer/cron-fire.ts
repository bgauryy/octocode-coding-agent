import { type AgentDb, type TimerRow, timers } from "../../../../db/src/api.ts";
import { type CronSpec, nextRunAt } from "./cron.ts";

/** What claiming a due cron row did besides firing it. */
export type CronEvent =
	| { kind: "skipped"; row: TimerRow; next: number }
	| { kind: "stopped"; row: TimerRow; reason: string };

export interface CronClaim {
	/** The row to fire: counted and moved to its next run; absent when the run was skipped or the timer stopped. */
	row?: TimerRow;
	event?: CronEvent;
}

/**
 * Claims a due cron row. One run missed while no process held the session fires once; when another run was also missed
 * (the row is late by more than one period) it is skipped and the timer moves on, since a catch-up of old runs is not wanted.
 * `stop` may end the timer instead of running it (the spending cap).
 */
export function claimCron(
	db: AgentDb["db"],
	due: TimerRow,
	spec: CronSpec,
	sessionId: string,
	now: number,
	stop?: (row: TimerRow) => string | undefined,
): CronClaim {
	const reason = stop?.(due);
	if (reason !== undefined) {
		const row = timers.finish(db, due.id, "failed", reason, now);
		return row ? { event: { kind: "stopped", row, reason } } : {};
	}
	const next = nextRunAt(spec, due.id, now) ?? (due.deadline_at ?? now) + 1;
	const following = nextRunAt(spec, due.id, due.due_at);
	if (following !== undefined && following <= now) {
		const skipped = timers.skipCron(db, due.id, sessionId, now, next);
		if (!skipped) return {};
		const past = skipped.deadline_at !== null && next > skipped.deadline_at;
		const row = past ? (timers.finish(db, due.id, "expired", "deadline", now) ?? skipped) : skipped;
		return { event: { kind: "skipped", row, next } };
	}
	const row = timers.claimCron(db, due.id, sessionId, now, next);
	return row ? { row } : {};
}
