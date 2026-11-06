import type { NewTimer, TimerResult, TimerRow } from "../../../../db/src/api.ts";

/** Active timers one session may hold. */
export const MAX_ACTIVE = 10;
/** The shortest interval between wakes: anything faster is polling, which a turn per run makes costly. */
export const MIN_EVERY_SECONDS = 30;
/** Wakes of an `every` timer without its own maxRuns. */
const DEFAULT_MAX_RUNS = 20;
/** How often an `until` condition is checked by default, and at least; checks wake nobody until one is met. */
const DEFAULT_CHECK_SECONDS = 15;
const MIN_CHECK_SECONDS = 5;
/** How long an `until` timer waits without a deadline of its own. */
const DEFAULT_UNTIL_DEADLINE_SECONDS = 3600;
/** Characters of a check's output kept on the row and shown on wake. */
export const OUTPUT_CAP = 2000;

/** A condition the code checks: a closed union, so a new kind is one entry here and one in `condition.ts`. */
export type TimerCondition = { kind: "command"; command: string } | { kind: "unlocked"; path: string };

/** The `set` arguments of the `timer` tool. */
export interface TimerSetInput {
	note?: string;
	after?: number;
	every?: number;
	until?: { command?: string; unlocked?: string };
	maxRuns?: number;
	deadline?: number;
}

const seconds = (value: number | undefined, name: string): number | undefined => {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a number of seconds, 0 or more.`);
	return value;
};

/** The condition `until` names, or undefined; exactly one kind. */
function parseCondition(until: TimerSetInput["until"]): TimerCondition | undefined {
	if (!until) return undefined;
	const command = until.command?.trim();
	const unlocked = until.unlocked?.trim();
	if (command && unlocked) throw new Error("until takes one condition: command or unlocked, not both.");
	if (command) return { kind: "command", command };
	if (unlocked) return { kind: "unlocked", path: unlocked };
	throw new Error("until needs command (exit 0 stops the wait) or unlocked (a path no other agent reserves).");
}

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
	if (!note) throw new Error("set needs a note: what to do when the timer wakes you.");
	const condition = parseCondition(input.until);
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
	if (condition) {
		if (input.maxRuns !== undefined) throw new Error("maxRuns counts wakes of every; an until timer wakes once.");
		const interval = every ?? DEFAULT_CHECK_SECONDS;
		if (interval < MIN_CHECK_SECONDS) throw new Error(`every with until is at least ${MIN_CHECK_SECONDS} seconds.`);
		return {
			...base,
			kind: "until",
			dueAt: now + (after ?? 0) * 1000,
			intervalMs: interval * 1000,
			condition: {
				kind: condition.kind,
				value: condition.kind === "command" ? condition.command : condition.path,
				cwd: owner.cwd,
			},
			deadlineAt: now + (deadline ?? DEFAULT_UNTIL_DEADLINE_SECONDS) * 1000,
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
		throw new Error("maxRuns and deadline bound every or until; a timer with only after wakes once.");
	return { ...base, kind: "once", dueAt: now + after * 1000 };
}

/** The stored condition of an `until` row. */
export function rowCondition(row: TimerRow): TimerCondition | undefined {
	if (row.condition_kind === "command" && row.condition) return { kind: "command", command: row.condition };
	if (row.condition_kind === "unlocked" && row.condition) return { kind: "unlocked", path: row.condition };
	return undefined;
}

/** A check of a condition: met, not yet, or not possible (refused or unrunnable: the timer fails). */
export type CheckOutcome = TimerResult & { met: boolean; refused?: string };

/** What a claimed fire does next: wake now (ending the timer with a status, or not), or stay silent until the next check. */
export type FireDecision =
	| { wake: true; end?: { status: "done" | "expired" | "failed"; reason: string } }
	| { wake: false; end?: undefined };

/** Decides a claimed fire of `row` (already counted and moved to its next due time), with its check outcome if any. */
export function decideFire(row: TimerRow, check?: CheckOutcome): FireDecision {
	const pastDeadline = row.deadline_at !== null && row.due_at > row.deadline_at;
	if (row.kind === "once") return { wake: true };
	if (row.kind === "every") {
		if (row.max_runs !== null && row.runs >= row.max_runs)
			return { wake: true, end: { status: "done", reason: "maxRuns" } };
		return pastDeadline ? { wake: true, end: { status: "expired", reason: "deadline" } } : { wake: true };
	}
	if (check?.refused) return { wake: true, end: { status: "failed", reason: check.refused } };
	if (check?.met) return { wake: true, end: { status: "done", reason: "met" } };
	return pastDeadline ? { wake: true, end: { status: "expired", reason: "deadline" } } : { wake: false };
}

const describeCondition = (row: TimerRow) =>
	row.condition_kind === "unlocked" ? `${row.condition} unlocked` : `\`${row.condition}\` exits 0`;

/** Why a wake happened, in a few words: the headline of the notice and of the model's message. */
function wakeReason(row: TimerRow): string {
	if (row.kind === "once") return "time is up";
	if (row.kind === "every") {
		const run = `run ${row.runs}${row.max_runs !== null ? ` of ${row.max_runs}` : ""}`;
		if (row.stop_reason === "maxRuns") return `${run}, the last`;
		if (row.stop_reason === "deadline") return `${run}, deadline reached: the last`;
		return run;
	}
	if (row.stop_reason === "met") return `condition met: ${describeCondition(row)}`;
	if (row.stop_reason === "deadline") return `deadline reached before ${describeCondition(row)}`;
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
	};
}

/** What the model reads on wake: the timer, why it fired, its note, and the last check's result. */
export function wakeText(row: TimerRow): string {
	const ended = row.status === "active" ? "" : ` (timer ${row.status})`;
	const lines = [`Timer ${row.id} fired: ${wakeReason(row)}${ended}.`, `Note: ${row.note}`];
	if (row.last_output !== null || row.last_exit !== null)
		lines.push(
			`Last check${row.last_exit !== null ? ` (exit ${row.last_exit})` : ""}: ${row.last_output?.trim() || "(no output)"}`,
		);
	return lines.join("\n");
}

/** One line per timer for `list`. */
export function timerLine(row: TimerRow, now: number): string {
	const when =
		row.status === "active"
			? `next ${row.kind === "until" ? "check" : "wake"} in ${Math.max(0, Math.round((row.due_at - now) / 1000))}s`
			: `${row.status}${row.stop_reason ? ` (${row.stop_reason})` : ""}`;
	const schedule =
		row.kind === "once"
			? "once"
			: row.kind === "every"
				? `every ${row.interval_ms! / 1000}s, ${row.runs}/${row.max_runs ?? "∞"} runs`
				: `until ${describeCondition(row)}`;
	return `${row.id} · ${schedule} · ${when} · ${row.note}`;
}
