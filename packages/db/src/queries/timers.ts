import type { DatabaseSync } from "node:sqlite";

/** A timer row as stored (`TIMERS_SCHEMA`). */
export interface TimerRow {
	id: number;
	workspace_id: string;
	session_id: string;
	agent: string | null;
	tool_call_id: string | null;
	note: string;
	kind: TimerKind;
	due_at: number;
	interval_ms: number | null;
	condition_kind: TimerConditionKind | null;
	condition: string | null;
	cwd: string | null;
	max_runs: number | null;
	runs: number;
	deadline_at: number | null;
	status: TimerStatus;
	stop_reason: string | null;
	last_fired_at: number | null;
	last_exit: number | null;
	last_output: string | null;
	created_at: number;
	updated_at: number;
	ended_at: number | null;
}

export type TimerKind = "once" | "every" | "until";
export type TimerConditionKind = "command" | "unlocked";
export type TimerStatus = "active" | "done" | "cancelled" | "expired" | "failed";

/** The stored fields of a new timer. */
export interface NewTimer {
	workspaceId: string;
	sessionId: string;
	agent?: string;
	toolCallId?: string;
	note: string;
	kind: TimerKind;
	dueAt: number;
	intervalMs?: number;
	condition?: { kind: TimerConditionKind; value: string; cwd?: string };
	maxRuns?: number;
	deadlineAt?: number;
	at: number;
}

const row = (value: unknown) => value as TimerRow | undefined;

/** Inserts an active timer and returns it. */
export function insert(db: DatabaseSync, timer: NewTimer): TimerRow {
	return row(
		db
			.prepare(
				`INSERT INTO timers (workspace_id, session_id, agent, tool_call_id, note, kind, due_at, interval_ms, condition_kind,
				 condition, cwd, max_runs, deadline_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
			)
			.get(
				timer.workspaceId,
				timer.sessionId,
				timer.agent ?? null,
				timer.toolCallId ?? null,
				timer.note,
				timer.kind,
				timer.dueAt,
				timer.intervalMs ?? null,
				timer.condition?.kind ?? null,
				timer.condition?.value ?? null,
				timer.condition?.cwd ?? null,
				timer.maxRuns ?? null,
				timer.deadlineAt ?? null,
				timer.at,
				timer.at,
			),
	)!;
}

export function get(db: DatabaseSync, id: number): TimerRow | undefined {
	return row(db.prepare("SELECT * FROM timers WHERE id = ?").get(id));
}

/** A session's timers, newest first: the active ones, or with `all` also the ended ones. */
export function forSession(db: DatabaseSync, sessionId: string, all = false, limit = 50): TimerRow[] {
	return db
		.prepare(
			`SELECT * FROM timers WHERE session_id = ? ${all ? "" : "AND status = 'active'"} ORDER BY status <> 'active', id DESC LIMIT ?`,
		)
		.all(sessionId, limit) as unknown as TimerRow[];
}

export function activeCount(db: DatabaseSync, sessionId: string): number {
	return Number(
		db.prepare("SELECT COUNT(*) AS n FROM timers WHERE session_id = ? AND status = 'active'").get(sessionId)?.n ?? 0,
	);
}

/** When the session's next active timer is due, or undefined when it has none. */
export function nextDue(db: DatabaseSync, sessionId: string): number | undefined {
	const at = db
		.prepare("SELECT MIN(due_at) AS at FROM timers WHERE session_id = ? AND status = 'active'")
		.get(sessionId)?.at;
	return typeof at === "number" ? at : undefined;
}

/** The session's active timers due at `now`, oldest due first. */
export function due(db: DatabaseSync, sessionId: string, now: number): TimerRow[] {
	return db
		.prepare("SELECT * FROM timers WHERE session_id = ? AND status = 'active' AND due_at <= ? ORDER BY due_at, id")
		.all(sessionId, now) as unknown as TimerRow[];
}

/**
 * Claims one fire of a due timer in a single guarded statement, so of two connections only one gets the row back. It
 * counts the run and moves `due_at` to the first interval mark after `now`: runs missed while no process held the session
 * coalesce into this one. A `once` timer ends here (`done`, `fired`); the claimer ends the others with `finish`.
 */
export function claim(db: DatabaseSync, id: number, sessionId: string, now: number): TimerRow | undefined {
	return row(
		db
			.prepare(
				`UPDATE timers SET runs = runs + 1, last_fired_at = ?1, updated_at = ?1,
				 due_at = CASE WHEN interval_ms IS NULL THEN due_at ELSE due_at + interval_ms * (CAST((?1 - due_at) / interval_ms AS INTEGER) + 1) END,
				 status = CASE kind WHEN 'once' THEN 'done' ELSE status END,
				 stop_reason = CASE kind WHEN 'once' THEN 'fired' ELSE stop_reason END,
				 ended_at = CASE kind WHEN 'once' THEN ?1 ELSE ended_at END
				 WHERE id = ?2 AND session_id = ?3 AND status = 'active' AND due_at <= ?1 RETURNING *`,
			)
			.get(now, id, sessionId),
	);
}

/** A condition check's result: the command's exit code (null for a built-in condition) and a capped excerpt. */
export interface TimerResult {
	exit: number | null;
	output: string;
}

/** Stores the last check's result on an active timer. */
export function recordResult(db: DatabaseSync, id: number, result: TimerResult, now: number): void {
	db.prepare("UPDATE timers SET last_exit = ?, last_output = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(
		result.exit,
		result.output,
		now,
		id,
	);
}

/** Ends an active timer with `status` and why; returns it, or undefined when it had already ended (a cancel won). */
export function finish(
	db: DatabaseSync,
	id: number,
	status: Exclude<TimerStatus, "active">,
	reason: string,
	now: number,
): TimerRow | undefined {
	return row(
		db
			.prepare(
				"UPDATE timers SET status = ?1, stop_reason = ?2, ended_at = ?3, updated_at = ?3 WHERE id = ?4 AND status = 'active' RETURNING *",
			)
			.get(status, reason, now, id),
	);
}

/** Cancels the session's active timer `id`; returns it, or undefined when the session has no such active timer. */
export function cancel(db: DatabaseSync, id: number, sessionId: string, now: number): TimerRow | undefined {
	return row(
		db
			.prepare(
				`UPDATE timers SET status = 'cancelled', stop_reason = 'cancelled', ended_at = ?1, updated_at = ?1
				 WHERE id = ?2 AND session_id = ?3 AND status = 'active' RETURNING *`,
			)
			.get(now, id, sessionId),
	);
}

/**
 * Retention: drops ended timers that ended before `cutoff`, and active ones untouched since then (their session was never
 * resumed to fire them). Returns the rows removed.
 */
export function purgeBefore(db: DatabaseSync, cutoff: number): number {
	return Number(
		db
			.prepare(
				"DELETE FROM timers WHERE (status <> 'active' AND ended_at < ?1) OR (status = 'active' AND updated_at < ?1)",
			)
			.run(cutoff).changes,
	);
}
