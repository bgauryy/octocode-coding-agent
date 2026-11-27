import type { TimerRow } from "../../../../db/src/api.ts";
import type { WorkRow } from "../shared/running-work.ts";
import { formatSpan } from "../shared/format.ts";
import { describeCondition } from "./conditions/index.ts";
import { cronOf, cronSummary } from "./cron.ts";
import { rowCondition } from "./model.ts";

/** What the timer waits for, in a few words: its condition, its interval, or its delay. */
function waitsFor(row: TimerRow): string {
	if (row.kind === "until") {
		const condition = rowCondition(row);
		return `until ${condition ? describeCondition(condition) : `${row.condition_kind ?? "condition"} (unreadable)`}`;
	}
	const cron = cronOf(row);
	if (cron) return cronSummary(row, cron);
	if (row.kind === "every") {
		const run = `run ${row.runs + 1}${row.max_runs !== null ? ` of ${row.max_runs}` : ""}`;
		return `every ${formatSpan(row.interval_ms ?? 0)} · ${run}`;
	}
	return `after ${formatSpan(Math.max(0, row.due_at - row.created_at))}`;
}

/** The backlog items a timer's note names (`B12`); none for a timer that waits on an item's state, which the item's own end wakes. */
function itemsOf(row: TimerRow): string[] {
	if (row.condition_kind === "item") return [];
	return [...new Set([...row.note.matchAll(/\bB(\d{1,9})\b/gi)].map((match) => `B${Number(match[1])}`))];
}

/**
 * The running-work rows of a session's active timers (`shared/running-work.ts`): the timer's id, what it waits for with
 * its note after it, and its time left: the next wake, or for a condition the deadline (its checks wake nobody).
 */
export function timerWorkRows(rows: readonly TimerRow[]): WorkRow[] {
	return rows
		.filter((row) => row.status === "active")
		.sort((a, b) => a.id - b.id)
		.map((row) => ({
			kind: "timer",
			id: `#${row.id}`,
			title: waitsFor(row),
			...(row.note.trim() ? { detail: row.note.trim().split("\n", 1)[0] } : {}),
			...(itemsOf(row).length ? { items: itemsOf(row) } : {}),
			startedAt: row.created_at,
			dueAt: row.kind === "until" ? (row.deadline_at ?? row.due_at) : row.due_at,
		}));
}
