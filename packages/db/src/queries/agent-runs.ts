import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { num, type Row } from "../rows.ts";

/**
 * The audit of one run of an agent (`agent_runs`): who it was, where it worked, what it was for, how it
 * ended and what it cost. The parent writes the start (`begin`) and the outcome (`finish`); the agent's own join links
 * its registration (`opened`), and whoever retires its `agents` row writes the end (`ended`), the parent's `finish`
 * only when no row is left to retire. One open run (no `endedAt`) exists per agent name: a new one closes the old.
 */
export interface AgentRun {
	runId: string;
	/** The `create` event's registration id; absent until the agent joined (a run that never started has none). */
	registrationId: string | undefined;
	workspaceId: string;
	agentId: string;
	kind: "main" | "child";
	parentAgentId: string | undefined;
	parentSessionId: string | undefined;
	sessionId: string | undefined;
	startedBy: string | undefined;
	profile: string | undefined;
	model: string | undefined;
	goal: string | undefined;
	backlog: { workspaceId: string; seq: number } | undefined;
	cwd: string | undefined;
	branch: string | undefined;
	processTitle: string | undefined;
	pid: number | undefined;
	startedAt: number;
	endedAt: number | undefined;
	endReason: string | undefined;
	endDetail: string | undefined;
	toolCalls: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	cost: number;
	unpriced: boolean;
	outcome: string | undefined;
	outcomeSource: string | undefined;
	reportPath: string | undefined;
	/** The files the agent changed during the run: the count and the first `FILES_LISTED` paths. */
	filesChanged: { count: number; paths: string[] } | undefined;
}

/** How many changed paths a run keeps (the count stays exact). */
export const FILES_LISTED = 50;

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const number = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);

function filesOf(value: unknown): AgentRun["filesChanged"] {
	if (typeof value !== "string") return undefined;
	try {
		const parsed = JSON.parse(value) as { count?: unknown; paths?: unknown };
		return typeof parsed.count === "number" && Array.isArray(parsed.paths)
			? { count: parsed.count, paths: parsed.paths.filter((path): path is string => typeof path === "string") }
			: undefined;
	} catch {
		return undefined;
	}
}

/** A stored row as the run it records. */
function decode(row: Row): AgentRun {
	const backlogSeq = number(row.backlog_seq);
	return {
		runId: String(row.run_id),
		registrationId: text(row.registration_id),
		workspaceId: String(row.workspace_id),
		agentId: String(row.agent_id),
		kind: row.kind === "main" ? "main" : "child",
		parentAgentId: text(row.parent_agent_id),
		parentSessionId: text(row.parent_session_id),
		sessionId: text(row.session_id),
		startedBy: text(row.started_by),
		profile: text(row.profile),
		model: text(row.model),
		goal: text(row.goal),
		backlog:
			backlogSeq !== undefined && typeof row.backlog_workspace === "string"
				? { workspaceId: row.backlog_workspace, seq: backlogSeq }
				: undefined,
		cwd: text(row.cwd),
		branch: text(row.branch),
		processTitle: text(row.process_title),
		pid: number(row.pid),
		startedAt: num(row.started_at),
		endedAt: number(row.ended_at),
		endReason: text(row.end_reason),
		endDetail: text(row.end_detail),
		toolCalls: num(row.tool_calls),
		input: num(row.input),
		cacheRead: num(row.cache_read),
		cacheWrite: num(row.cache_write),
		output: num(row.output),
		cost: num(row.cost),
		unpriced: row.unpriced === 1,
		outcome: text(row.outcome),
		outcomeSource: text(row.outcome_source),
		reportPath: text(row.report_path),
		filesChanged: filesOf(row.files_changed),
	};
}

/** What the parent knows when it starts a child. */
export interface RunStart {
	workspaceId: string;
	agentId: string;
	parentAgentId?: string | undefined;
	parentSessionId?: string | undefined;
	startedBy?: string | undefined;
	profile?: string | undefined;
	model?: string | undefined;
	goal?: string | undefined;
	backlog?: { workspaceId: string; seq: number } | undefined;
}

const CLOSE_OPEN =
	"UPDATE agent_runs SET ended_at = ?, end_reason = 'crashed', end_detail = ? WHERE agent_id = ? AND ended_at IS NULL";

export function latest(db: DatabaseSync, agentId: string): AgentRun | undefined {
	const row = db
		.prepare("SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1")
		.get(agentId);
	return row ? decode(row) : undefined;
}

/** The parent starts child `start.agentId`: its run opens, and an earlier run of that name that never ended is closed as crashed. Returns the run id. */
export function begin(db: DatabaseSync, start: RunStart, now = Date.now()): string {
	db.prepare(CLOSE_OPEN).run(now, "superseded by a new run of the same name", start.agentId);
	const runId = randomUUID();
	db.prepare(
		`INSERT INTO agent_runs (run_id, workspace_id, agent_id, kind, parent_agent_id, parent_session_id, started_by, profile, model, goal, backlog_workspace, backlog_seq, started_at)
		 VALUES (?, ?, ?, 'child', ?, COALESCE(?, (SELECT lifecycle_session_id FROM agents WHERE id = ?)), ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		runId,
		start.workspaceId,
		start.agentId,
		start.parentAgentId ?? null,
		start.parentSessionId ?? null,
		start.parentAgentId ?? null,
		start.startedBy ?? null,
		start.profile ?? null,
		start.model ?? null,
		start.goal ?? null,
		start.backlog?.workspaceId ?? null,
		start.backlog?.seq ?? null,
		now,
	);
	return runId;
}

/**
 * The agent `row` (an `agents` row that just got its registration) joined: the run its parent opened takes the
 * registration and what the agent knows about itself; with no such run (a main session, a child whose parent did not
 * record one) the registration id is the run's id. Returns the run.
 */
export function opened(db: DatabaseSync, row: Row, now = Date.now()): AgentRun {
	const registration = String(row.registration_id);
	const linked = db
		.prepare(
			`UPDATE agent_runs SET registration_id = ?, session_id = ?, parent_session_id = COALESCE(parent_session_id, (SELECT lifecycle_session_id FROM agents WHERE id = ?)), pid = ?, cwd = ?, branch = ?, process_title = ?, model = COALESCE(?, model), goal = COALESCE(?, goal)
			 WHERE run_id = (SELECT run_id FROM agent_runs WHERE agent_id = ? AND ended_at IS NULL AND registration_id IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1)
			 RETURNING *`,
		)
		.get(
			registration,
			(row.lifecycle_session_id as string | null) ?? null,
			(row.parent_id as string | null) ?? null,
			num(row.pid),
			(row.cwd as string | null) ?? null,
			(row.branch as string | null) ?? null,
			(row.process_title as string | null) ?? null,
			(row.model as string | null) ?? null,
			(row.task as string | null) ?? null,
			String(row.id),
		);
	if (linked) return decode(linked);
	db.prepare(CLOSE_OPEN).run(now, "superseded by a new run of the same name", String(row.id));
	const parent =
		typeof row.parent_id === "string"
			? (db.prepare("SELECT lifecycle_session_id FROM agents WHERE id = ?").get(row.parent_id) as Row | undefined)
			: undefined;
	const inserted = db
		.prepare(
			`INSERT INTO agent_runs (run_id, registration_id, workspace_id, agent_id, kind, parent_agent_id, parent_session_id, session_id, started_by, profile, model, goal, cwd, branch, process_title, pid, started_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
		)
		.get(
			registration,
			registration,
			String(row.workspace_id),
			String(row.id),
			row.parent_id ? "child" : "main",
			(row.parent_id as string | null) ?? null,
			(parent?.lifecycle_session_id as string | null) ?? null,
			(row.lifecycle_session_id as string | null) ?? null,
			row.parent_id ? null : "user",
			String(row.role),
			(row.model as string | null) ?? null,
			(row.task as string | null) ?? null,
			(row.cwd as string | null) ?? null,
			(row.branch as string | null) ?? null,
			(row.process_title as string | null) ?? null,
			num(row.pid),
			num(row.joined_at),
		) as Row;
	return decode(inserted);
}

/** The changed files of `agent` within `[from, to]`: how many distinct paths, and the first `FILES_LISTED`. */
function changedFiles(db: DatabaseSync, agent: string, from: number, to: number): { count: number; paths: string[] } {
	const where = "agent = ? AND at >= ? AND at <= ?";
	const count = num(db.prepare(`SELECT COUNT(DISTINCT path) AS n FROM edits WHERE ${where}`).get(agent, from, to)?.n);
	const paths = (
		db
			.prepare(`SELECT DISTINCT path FROM edits WHERE ${where} ORDER BY path LIMIT ${FILES_LISTED}`)
			.all(agent, from, to) as Row[]
	).map((each) => String(each.path));
	return { count, paths };
}

/**
 * Agent `row` is being retired (`agents.remove`): its open run ends with `reason`, the row's last numbers and the files it
 * changed. Undefined when it has no open run. Called before the row is deleted.
 */
export function ended(
	db: DatabaseSync,
	row: Row,
	reason: string,
	detail: string | undefined,
	now: number,
): AgentRun | undefined {
	const id = String(row.id);
	const open = db
		.prepare(
			"SELECT started_at FROM agent_runs WHERE agent_id = ? AND ended_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1",
		)
		.get(id);
	if (!open) return undefined;
	const files = changedFiles(db, id, num(open.started_at), now);
	const updated = db
		.prepare(
			`UPDATE agent_runs SET ended_at = ?, end_reason = ?, end_detail = ?, tool_calls = ?, input = ?, cache_read = ?, cache_write = ?, output = ?, cost = ?, unpriced = ?,
				cwd = COALESCE(?, cwd), branch = COALESCE(?, branch), process_title = COALESCE(?, process_title), pid = COALESCE(?, pid), files_changed = ?
			 WHERE run_id = (SELECT run_id FROM agent_runs WHERE agent_id = ? AND ended_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1)
			 RETURNING *`,
		)
		.get(
			now,
			reason,
			detail ?? null,
			num(row.tool_calls),
			num(row.input),
			num(row.cache_read),
			num(row.cache_write),
			num(row.output),
			num(row.cost),
			num(row.unpriced),
			(row.cwd as string | null) ?? null,
			(row.branch as string | null) ?? null,
			(row.process_title as string | null) ?? null,
			num(row.pid),
			JSON.stringify(files),
			id,
		);
	return updated ? decode(updated) : undefined;
}

/** What the parent learned when the run finished. */
export interface RunOutcome {
	outcome?: string | undefined;
	outcomeSource?: string | undefined;
	reportPath?: string | undefined;
	endDetail?: string | undefined;
	/** Why the run ended, as the parent sees it (and `endDetail`, its words): used only when no `agents` row is left to retire, and the run has no end yet. */
	endReason: string;
}

/**
 * The parent's word on the latest run of `agentId`: its outcome and exit. The end itself belongs to whoever retires the
 * row (a lingering child is still there); with no row left (it never joined, or was retired without a run to end) the
 * parent's reason closes the run. Whether a run was found.
 */
export function finish(db: DatabaseSync, agentId: string, outcome: RunOutcome, now = Date.now()): boolean {
	const free = "ended_at IS NULL AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = agent_runs.agent_id)";
	return (
		db
			.prepare(
				`UPDATE agent_runs SET outcome = COALESCE(?, outcome), outcome_source = COALESCE(?, outcome_source), report_path = COALESCE(?, report_path),
					end_reason = CASE WHEN ${free} THEN ? ELSE end_reason END, end_detail = CASE WHEN ${free} THEN ? ELSE end_detail END,
					ended_at = CASE WHEN ${free} THEN ? ELSE ended_at END
				 WHERE run_id = (SELECT run_id FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1)`,
			)
			.run(
				outcome.outcome ?? null,
				outcome.outcomeSource ?? null,
				outcome.reportPath ?? null,
				outcome.endReason,
				outcome.endDetail ?? null,
				now,
				agentId,
			).changes > 0
	);
}

/** The runs that began last, newest first: of `workspaceId` when given, of `agentId` when given. */
export function recent(
	db: DatabaseSync,
	filter: { workspaceId?: string; agentId?: string; limit?: number } = {},
): AgentRun[] {
	const clauses: string[] = [];
	const values: string[] = [];
	if (filter.workspaceId) {
		clauses.push("workspace_id = ?");
		values.push(filter.workspaceId);
	}
	if (filter.agentId) {
		clauses.push("agent_id = ?");
		values.push(filter.agentId);
	}
	const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
	return (
		db
			.prepare(`SELECT * FROM agent_runs${where} ORDER BY started_at DESC, rowid DESC LIMIT ?`)
			.all(...values, filter.limit ?? 10) as Row[]
	).map(decode);
}

/**
 * The runs of session `sessionId` and of every agent below it (a run whose parent session is in the tree, whether or
 * not it ever joined), oldest first: the profile of a session that has ended reads its agents here, where `agents`
 * only lists the live ones.
 */
export function inSessionTree(db: DatabaseSync, sessionId: string): AgentRun[] {
	return (
		db
			.prepare(
				`WITH RECURSIVE tree(sid) AS (
				   SELECT ? UNION SELECT r.session_id FROM agent_runs r JOIN tree ON r.parent_session_id = tree.sid WHERE r.session_id IS NOT NULL)
				 SELECT * FROM agent_runs WHERE session_id IN (SELECT sid FROM tree) OR parent_session_id IN (SELECT sid FROM tree)
				 ORDER BY started_at, rowid`,
			)
			.all(sessionId) as Row[]
	).map(decode);
}

/** The runs started for backlog item `seq` of `workspaceId`, newest first. */
export function forItem(db: DatabaseSync, workspaceId: string, seq: number): AgentRun[] {
	return (
		db
			.prepare(
				"SELECT * FROM agent_runs WHERE backlog_workspace = ? AND backlog_seq = ? ORDER BY started_at DESC, rowid DESC",
			)
			.all(workspaceId, seq) as Row[]
	).map(decode);
}

/**
 * The child runs started for items `seqs` of `workspaceId` that have not ended and whose agent or parent is still a
 * member (a queued child has not joined yet; a run its crashed parent left open is not live), newest first: who works on
 * each item of a page, in one statement. The one rule for "a live child run for an item": `resolveAgent` uses it too.
 */
export function openForItems(
	db: DatabaseSync,
	workspaceId: string,
	seqs: readonly number[],
): Array<{ seq: number; agentId: string }> {
	if (seqs.length === 0) return [];
	const rows = db
		.prepare(
			`SELECT r.backlog_seq, r.agent_id FROM agent_runs r
			 WHERE r.backlog_workspace = ? AND r.backlog_seq IN (${seqs.map(() => "?").join(", ")}) AND r.kind = 'child' AND r.ended_at IS NULL
			   AND (EXISTS (SELECT 1 FROM agents a WHERE a.id = r.agent_id) OR EXISTS (SELECT 1 FROM agents p WHERE p.id = r.parent_agent_id))
			 ORDER BY r.started_at DESC, r.rowid DESC`,
		)
		.all(workspaceId, ...seqs) as Row[];
	return rows.map((row) => ({ seq: num(row.backlog_seq), agentId: String(row.agent_id) }));
}

/** Deletes the runs that ended (or, never ended, began) before `cutoff`: the retention window (`retention.ts`). Returns how many went. */
export function purgeBefore(db: DatabaseSync, cutoff: number): number {
	return Number(db.prepare("DELETE FROM agent_runs WHERE COALESCE(ended_at, started_at) < ?").run(cutoff).changes);
}
