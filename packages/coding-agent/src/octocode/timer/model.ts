import type { NewTimer, TimerRow } from "../../../../db/src/api.ts";
import {
	conditionTiming,
	decodeCondition,
	describeCondition,
	encodeCondition,
	parseUntil,
} from "./conditions/index.ts";
import { formatSpan } from "../shared/format.ts";
import type { AgentEvent } from "../wake/catalog.ts";
import { removedStored } from "./conditions/removed.ts";
import { CHECK_CAPS } from "./judge.ts";
import type { CheckOutcome, TimerCondition } from "./conditions/types.ts";

export type { CheckOutcome, TimerCondition };

/** Active timers one session may hold. */
export const MAX_ACTIVE = 10;
/** The shortest interval between wakes: anything faster is polling, which a turn per run makes costly. */
export const MIN_EVERY_SECONDS = 30;
/** Wakes of an `every` timer without its own maxRuns. */
const DEFAULT_MAX_RUNS = 20;
/** At least how often an `until` condition is checked; the default is its kind's (`conditionTiming`). Checks wake nobody until one is met. */
export const MIN_CHECK_SECONDS = 5;
/** How long an `until` timer waits without a deadline of its own. */
const DEFAULT_UNTIL_DEADLINE_SECONDS = 3600;

/** The `set` and `on` arguments of the `wait` tool, with `on`'s event already mapped to its `until` condition. */
export interface TimerSetInput {
	note?: string;
	after?: number;
	every?: number;
	/** Exactly one condition of the closed list (`conditions/index.ts`); validated by `parseUntil`. */
	until?: unknown;
	maxRuns?: number;
	deadline?: number;
	/** With `until`: `false` keeps listening after a wake, up to `maxRuns` (default 20) wakes or the deadline. */
	once?: boolean;
}

/** The longest wait or interval one timer takes: a larger number is a typo, and past 2^53 ms it would not store as an integer. */
const MAX_SECONDS = 30 * 24 * 3600;

const seconds = (value: number | undefined, name: string): number | undefined => {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number of seconds, 0 or more.`);
	if (value > MAX_SECONDS) throw new Error(`${name} is at most ${MAX_SECONDS} seconds (30 days).`);
	return value;
};

/**
 * The stored fields of a timer from the tool's `set` arguments: `until` makes an `until` timer (checked every `every`
 * seconds, default 15, until met or the deadline, default an hour), `every` a repeating one (at most maxRuns wakes,
 * default 20), and `after` alone a one-shot. The first wake or check is `after` seconds from `now` (default: one interval).
 */
export function timerFields(
	input: TimerSetInput,
	now: number,
	owner: { workspaceId: string; sessionId: string; agent?: string; toolCallId?: string; cwd: string },
): NewTimer {
	const note = input.note?.trim();
	if (!note) throw new Error("set needs a note: what to do when the wait wakes you.");
	const condition = parseUntil(input.until);
	const after = seconds(input.after, "after");
	const every = seconds(input.every, "every");
	const deadline = seconds(input.deadline, "deadline");
	if (input.maxRuns !== undefined && !(Number.isInteger(input.maxRuns) && input.maxRuns >= 1))
		throw new Error("maxRuns must be a whole number, 1 or more.");
	const base = {
		workspaceId: owner.workspaceId,
		sessionId: owner.sessionId,
		...(owner.agent ? { agent: owner.agent } : {}),
		...(owner.toolCallId ? { toolCallId: owner.toolCallId } : {}),
		note,
		at: now,
	};
	if (!condition && input.once !== undefined) throw new Error("once belongs to on: set wakes by time.");
	if (condition) {
		if (input.maxRuns !== undefined && input.once !== false)
			throw new Error("maxRuns counts wakes of every or of on with once: false; a listener wakes once.");
		const timing = conditionTiming(condition);
		const interval = every ?? (timing.watched ? timing.safetyMs : timing.pollMs) / 1000;
		if (interval < MIN_CHECK_SECONDS) throw new Error(`every with until is at least ${MIN_CHECK_SECONDS} seconds.`);
		const deadlineAt = now + (deadline ?? DEFAULT_UNTIL_DEADLINE_SECONDS) * 1000;
		return {
			...base,
			kind: "until",
			dueAt: Math.min(now + (after ?? 0) * 1000, deadlineAt),
			intervalMs: interval * 1000,
			condition: {
				kind: condition.kind,
				value: encodeCondition(condition),
				cwd: owner.cwd,
				...(input.once === false ? { baseline: persistState(false, 0) } : {}),
			},
			...(input.once === false ? { maxRuns: input.maxRuns ?? DEFAULT_MAX_RUNS } : {}),
			deadlineAt,
		};
	}
	if (every !== undefined) {
		if (every < MIN_EVERY_SECONDS)
			throw new Error(`every is at least ${MIN_EVERY_SECONDS} seconds; to wait for a condition, add until.`);
		return {
			...base,
			kind: "every",
			dueAt: now + (after ?? every) * 1000,
			intervalMs: every * 1000,
			maxRuns: input.maxRuns ?? DEFAULT_MAX_RUNS,
			...(deadline !== undefined ? { deadlineAt: now + deadline * 1000 } : {}),
		};
	}
	if (after === undefined) throw new Error("set needs after (one wake), every (repeating) or until (a condition).");
	if (input.maxRuns !== undefined || deadline !== undefined)
		throw new Error("maxRuns and deadline bound every or until; a wait with only after wakes once.");
	return { ...base, kind: "once", dueAt: now + after * 1000 };
}

/** The stored condition of an `until` row. */
export function rowCondition(row: TimerRow): TimerCondition | undefined {
	return row.condition_kind && row.condition ? decodeCondition(row.condition_kind, row.condition) : undefined;
}

/**
 * Why an `until` row set by an earlier version can no longer be checked: its condition kind was removed. The note names
 * the `command` to set it with again; the scheduler ends the row with it instead of leaving it to its deadline.
 */
export const rowRemoved = (row: TimerRow): string | undefined =>
	row.kind === "until" ? removedStored(row.condition_kind, row.condition) : undefined;

/**
 * A persistent `until` row (`once: false`, a `max_runs` of wakes) wakes when its condition turns true, not while it stays
 * true: `baseline` holds `armed` or `fired` and the wakes so far.
 */
const persistState = (fired: boolean, wakes: number): string => `${fired ? "fired" : "armed"}:${wakes}`;

const persistOf = (row: TimerRow): { fired: boolean; wakes: number } => ({
	fired: row.baseline?.startsWith("fired") ?? false,
	wakes: Number(row.baseline?.split(":")[1] ?? 0) || 0,
});

/** Whether `row` is a persistent listener, and if so whether its condition held at the last wake (a check that still holds is quiet). */
export const persistentFired = (row: TimerRow): boolean | undefined =>
	row.kind === "until" && row.max_runs !== null ? persistOf(row).fired : undefined;

/**
 * What a claimed fire does next: wake now (ending the timer with a status, or not), or stay silent until the next check.
 * `persist` is the new `baseline` of a persistent row.
 */
export type FireDecision =
	| { wake: true; end?: { status: "done" | "expired" | "failed"; reason: string }; persist?: string }
	| { wake: false; end?: undefined; persist?: string };

/** Decides a claimed fire of `row` (already counted and moved to its next due time), with its check outcome if any. */
export function decideFire(row: TimerRow, check?: CheckOutcome): FireDecision {
	const pastDeadline =
		row.deadline_at !== null &&
		(row.kind === "until" ? (row.last_fired_at ?? row.created_at) >= row.deadline_at : row.due_at > row.deadline_at);
	if (row.kind === "once") return { wake: true };
	if (row.kind === "every") {
		if (row.max_runs !== null && row.runs >= row.max_runs)
			return { wake: true, end: { status: "done", reason: "maxRuns" } };
		return pastDeadline ? { wake: true, end: { status: "expired", reason: "deadline" } } : { wake: true };
	}
	if (check?.refused) return { wake: true, end: { status: "failed", reason: check.refused } };
	if (row.max_runs !== null) {
		const state = persistOf(row);
		if (!check?.met) {
			if (pastDeadline) return { wake: true, end: { status: "expired", reason: "deadline" } };
			return state.fired ? { wake: false, persist: persistState(false, state.wakes) } : { wake: false };
		}
		if (state.fired)
			return pastDeadline ? { wake: true, end: { status: "expired", reason: "deadline" } } : { wake: false };
		const persist = persistState(true, state.wakes + 1);
		return state.wakes + 1 >= row.max_runs
			? { wake: true, end: { status: "done", reason: "maxRuns" }, persist }
			: { wake: true, persist };
	}
	if (check?.met) return { wake: true, end: { status: "done", reason: "met" } };
	return pastDeadline ? { wake: true, end: { status: "expired", reason: "deadline" } } : { wake: false };
}

const describeRow = (row: TimerRow) => {
	const condition = rowCondition(row);
	return condition
		? describeCondition(condition)
		: `${row.condition_kind ?? "condition"} (not readable by this version)`;
};

/** Why a wake happened, in a few words: the headline of the notice and of the model's message. */
function wakeReason(row: TimerRow): string {
	if (row.kind === "once") return "time is up";
	if (row.kind === "every") {
		const run = `run ${row.runs}${row.max_runs !== null ? ` of ${row.max_runs}` : ""}`;
		if (row.stop_reason === "maxRuns") return `${run}, the last`;
		if (row.stop_reason === "deadline") return `${run}, deadline reached: the last`;
		return run;
	}
	if (row.max_runs !== null && row.stop_reason !== "deadline") {
		const wake = `wake ${persistOf(row).wakes} of ${row.max_runs}`;
		return `condition met: ${describeRow(row)} (${wake}${row.stop_reason === "maxRuns" ? ", the last" : ""})`;
	}
	if (row.stop_reason === "met") return `condition met: ${describeRow(row)}`;
	if (row.stop_reason === "deadline") return `deadline reached before ${describeRow(row)}`;
	return `stopped: ${row.stop_reason ?? "condition could not be checked"}`;
}

/** The custom message's details, read by the renderer. */
export interface TimerWakeDetails {
	id: number;
	kind: TimerRow["kind"];
	status: TimerRow["status"];
	reason: string;
	note: string;
	runs: number;
	maxRuns: number | null;
	exit: number | null;
	output: string | null;
	/** The condition's kind, and for a `check` the model calls it made and what they cost. */
	conditionKind: TimerRow["condition_kind"];
	checks: number;
	spentUsd: number;
}

export function wakeDetails(row: TimerRow): TimerWakeDetails {
	return {
		id: row.id,
		kind: row.kind,
		status: row.status,
		reason: wakeReason(row),
		note: row.note,
		runs: row.runs,
		maxRuns: row.max_runs,
		exit: row.last_exit,
		output: row.last_output,
		conditionKind: row.condition_kind,
		checks: row.checks,
		spentUsd: row.spent_usd,
	};
}

/** What the model reads on wake: the timer, why it fired, its note, and the last check's result. */
export function wakeText(row: TimerRow): string {
	const ended = row.status === "active" ? "" : ` (wait ${row.status})`;
	const lines = [`Wait ${row.id} fired: ${wakeReason(row)}${ended}.`, `Note: ${row.note}`];
	if (row.status === "active" && (row.kind === "every" || row.max_runs !== null))
		lines.push(`It repeats: off id ${row.id} to stop it.`);
	if (row.last_output !== null || row.last_exit !== null)
		lines.push(
			`Last check${row.last_exit !== null ? ` (exit ${row.last_exit})` : ""}: ${row.last_output?.trim() || "(no output)"}`,
		);
	if (row.condition_kind === "check" && row.checks > 0)
		lines.push(
			`A small model judged this (${row.checks} judgment${row.checks === 1 ? "" : "s"}, $${row.spent_usd.toFixed(4)}): verify before relying on it.`,
		);
	return lines.join("\n");
}

/** The catalog event a wake of `row` is: a condition that held is its result, anything else (time, deadline, failure) is the clock. */
export function wakeEvent(row: TimerRow): AgentEvent<"check.result" | "time.due"> {
	const conditionMet =
		row.kind === "until" && (row.status === "active" || row.stop_reason === "met" || row.stop_reason === "maxRuns");
	if (conditionMet)
		return {
			kind: "check.result",
			timerId: row.id,
			exit: row.last_exit,
			output: row.last_output ?? "",
		};
	return {
		kind: "time.due",
		timerId: row.id,
		run: row.runs,
		...(row.max_runs !== null ? { maxRuns: row.max_runs } : {}),
		note: row.note,
	};
}

/** How an active `until` row learns of a change: an event source with a safety-net poll, or polling. */
function untilMode(row: TimerRow): string {
	const condition = rowCondition(row);
	if (row.kind !== "until" || !condition) return "";
	const timing = conditionTiming(condition);
	const mode = timing.watched ? "watching" : `polling every ${(row.interval_ms ?? 0) / 1000}s`;
	const spend =
		row.condition_kind === "check"
			? `, judged ${row.checks}/${CHECK_CAPS.perWaitChecks} for $${row.spent_usd.toFixed(4)}/$${CHECK_CAPS.perWaitUsd.toFixed(2)}`
			: "";
	return `${mode}${spend}`;
}

/** The longest an active row may still wait: `≤15m`, or empty without a deadline. */
const within = (row: TimerRow, now: number): string =>
	row.deadline_at === null ? "" : ` · ≤${formatSpan(row.deadline_at - now)}`;

/** One line per wait for `list`. */
export function timerLine(row: TimerRow, now: number): string {
	const wakes = row.max_runs !== null && row.kind === "until" ? ` ${persistOf(row).wakes}/${row.max_runs} wakes` : "";
	const when =
		row.status !== "active"
			? `${row.status}${row.stop_reason ? ` (${row.stop_reason})` : ""}`
			: row.kind === "until"
				? `${untilMode(row)}${within(row, now)}`
				: `next wake in ${Math.max(0, Math.round((row.due_at - now) / 1000))}s`;
	const schedule =
		row.kind === "once"
			? "once"
			: row.kind === "every"
				? `every ${row.interval_ms! / 1000}s, ${row.runs}/${row.max_runs ?? "∞"} runs`
				: `${row.max_runs !== null ? "on" : "until"} ${describeRow(row)}${wakes}`;
	return `${row.id} · ${schedule} · ${when} · ${row.note}`;
}

/** What `on` answers: the id, what it listens for and how long. The note was in the call. */
export function listeningLine(row: TimerRow, now: number): string {
	const up = row.max_runs !== null ? ` · up to ${row.max_runs} wakes` : "";
	return `Listening ${row.id}: ${describeRow(row)}${up}${within(row, now)}`;
}
