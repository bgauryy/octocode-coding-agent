import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Row } from "../rows.ts";
import { type AgentRun, opened } from "./agent-runs.ts";
import { itemRef } from "./agent-resolve.ts";
import { locate } from "./sessions.ts";

export const EVENT_TYPES = ["init", "create", "update", "delete", "compaction"] as const;
/** Why an agent row was retired: a `delete` event's `data.reason`. */
export const END_REASONS = [
	"completed",
	"failed",
	"stopped-user",
	"stopped-parent",
	"parent-gone",
	"crashed",
	"left",
] as const;
export type EndReason = (typeof END_REASONS)[number];
type EventType = (typeof EVENT_TYPES)[number];
export interface AgentEvent {
	time: string;
	id: string;
	name: string | null;
	parentId: string | null;
	sessionId: string | null;
	type: EventType;
	data: Record<string, unknown>;
	version: 1;
}
export interface EventRow extends AgentEvent {
	seq: number;
	workspace: string;
}
export interface LifecycleContext {
	activationId: string;
	sessionId: string;
	/** The session's working directory and session folder: recorded on its `sessions` row so an agent id reaches its transcript. */
	cwd?: string;
	dir?: string;
}

export function append(db: DatabaseSync, workspace: string, event: AgentEvent, key?: string): void {
	db.prepare(`INSERT INTO agent_events(id, workspace_id, time, name, parent_id, session_id, type, data, version, event_key)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(
		event.id,
		workspace,
		event.time,
		event.name,
		event.parentId,
		event.sessionId,
		event.type,
		JSON.stringify(event.data),
		event.version,
		key ?? null,
	);
}

function decode(row: Row): EventRow {
	return {
		seq: Number(row.seq),
		workspace: String(row.workspace_id),
		time: String(row.time),
		id: String(row.id),
		name: row.name as string | null,
		parentId: row.parent_id as string | null,
		sessionId: row.session_id as string | null,
		type: row.type as EventType,
		data: JSON.parse(String(row.data)) as Record<string, unknown>,
		version: 1,
	};
}

export interface EventFilter {
	agentId?: string;
	sessionId?: string;
	eventType?: EventType;
	since?: string;
	until?: string;
}
export function list(
	db: DatabaseSync,
	workspace: string,
	before = Number.MAX_SAFE_INTEGER,
	limit = 50,
	filter: EventFilter = {},
): EventRow[] {
	const clauses = ["workspace_id = ?", "seq < ?"];
	const values: Array<string | number> = [workspace, before];
	for (const [column, value, operator] of [
		["name", filter.agentId, "="],
		["session_id", filter.sessionId, "="],
		["type", filter.eventType, "="],
		["time", filter.since, ">="],
		["time", filter.until, "<="],
	] as const)
		if (value !== undefined) {
			clauses.push(`${column} ${operator} ?`);
			values.push(column === "time" ? new Date(value).toISOString() : value);
		}
	return (
		db
			.prepare(`SELECT * FROM agent_events WHERE ${clauses.join(" AND ")} ORDER BY seq DESC LIMIT ?`)
			.all(...values, limit) as Row[]
	).map(decode);
}

/** Event rows are append-only. The covering index answers this without loading event payloads. */
export function latestSequence(db: DatabaseSync, workspace: string): number {
	return Number(db.prepare("SELECT MAX(seq) AS seq FROM agent_events WHERE workspace_id = ?").get(workspace)?.seq ?? 0);
}

/** The newest event sequence of any workspace: the cursor a follower starts from to see only what happens next. */
export function head(db: DatabaseSync): number {
	return Number(db.prepare("SELECT MAX(seq) AS seq FROM agent_events").get()?.seq ?? 0);
}

/**
 * Presence events (`create`, `update`, `delete`) after sequence `after`, oldest first, at most `limit`: the lifecycle
 * bus's cursor read. Every workspace's, or only `workspace`'s when given. `seq` is the primary key, so this is one
 * range scan.
 */
export function since(db: DatabaseSync, after: number, limit = 200, workspace?: string): EventRow[] {
	const scope = workspace === undefined ? "" : " AND workspace_id = ?";
	return (
		db
			.prepare(
				`SELECT * FROM agent_events WHERE seq > ? AND type IN ('create','update','delete')${scope} ORDER BY seq LIMIT ?`,
			)
			.all(after, ...(workspace === undefined ? [] : [workspace]), limit) as Row[]
	).map(decode);
}

export function get(db: DatabaseSync, workspace: string, id: string): EventRow | undefined {
	const row = db.prepare("SELECT * FROM agent_events WHERE workspace_id = ? AND id = ?").get(workspace, id) as
		| Row
		| undefined;
	return row ? decode(row) : undefined;
}

export function member(db: DatabaseSync, id: string): Row | undefined {
	return db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
}

/**
 * What a `delete` event records of the row it ends, read before the `DELETE`: why, and the last heartbeat's numbers
 * (additive keys on a `version: 1` event; readers ignore keys they do not know). `startedAt` is the process start time
 * the row names, as stored.
 */
export function endData(
	db: DatabaseSync,
	row: Row,
	reason: string,
	detail?: string,
	run?: AgentRun,
): Record<string, unknown> {
	return {
		reason,
		...(detail ? { detail } : {}),
		startedAt: row.started ?? null,
		joinedAt: row.joined_at,
		seenAt: row.seen_at,
		status: row.status,
		toolCalls: row.tool_calls,
		input: row.input,
		cacheRead: row.cache_read,
		cacheWrite: row.cache_write,
		output: row.output,
		cost: row.cost,
		unpriced: row.unpriced === 1,
		pid: row.pid,
		...runData(db, row, run),
		...(run?.outcome ? { outcome: run.outcome } : {}),
		...(run?.filesChanged ? { filesChanged: run.filesChanged } : {}),
	};
}

/**
 * What a `create` and a `delete` event record of the run beside the agent (additive keys): its id, where it works, the
 * session that started it and the backlog item it is for, written as the workspace of the event reads it (`B36`).
 */
function runData(db: DatabaseSync, row: Row, run: AgentRun | undefined): Record<string, unknown> {
	return {
		...(run ? { runId: run.runId } : {}),
		...(run?.parentSessionId ? { parentSessionId: run.parentSessionId } : {}),
		...(row.cwd ? { cwd: row.cwd } : {}),
		...(row.branch ? { branch: row.branch } : {}),
		...(row.process_title ? { processTitle: row.process_title } : {}),
		...(run?.backlog
			? { backlogItem: itemRef(db, run.backlog.workspaceId, run.backlog.seq, String(row.workspace_id)) }
			: {}),
	};
}

/** Called in the presence mutation's transaction. A null registration marks nonpersistent/legacy presence. */
export function recordMember(
	db: DatabaseSync,
	row: Row,
	type: "create" | "update" | "delete",
	data: Record<string, unknown>,
	now: number,
	key?: string,
): void {
	if (typeof row.registration_id !== "string" || !row.persist_events) return;
	const registrationId = row.registration_id;
	append(
		db,
		String(row.workspace_id),
		{
			id: type === "create" ? registrationId : randomUUID(),
			time: new Date(now).toISOString(),
			name: String(row.id),
			parentId: (row.parent_id as string | null) ?? null,
			sessionId: (row.lifecycle_session_id as string | null) ?? null,
			type,
			version: 1,
			data: {
				agentId: row.id,
				role: row.role,
				model: row.model,
				goal: row.task,
				registrationId,
				activationId: row.activation_id,
				parentRegistrationId: row.parent_registration_id ?? null,
				...data,
			},
		},
		key,
	);
}

export function registerMember(db: DatabaseSync, id: string, context: LifecycleContext | undefined, now: number): void {
	if (!context) return;
	if (context.cwd || context.dir) locate(db, context.sessionId, context.cwd ?? null, context.dir ?? null);
	const row = member(db, id);
	const parent = typeof row?.parent_id === "string" ? member(db, row.parent_id) : undefined;
	const changed = db
		.prepare(`UPDATE agents SET registration_id = ?, persist_events = 1, activation_id = ?, lifecycle_session_id = ?, parent_registration_id = ?
		WHERE id = ? AND registration_id IS NULL`)
		.run(randomUUID(), context.activationId, context.sessionId, (parent?.registration_id as string | null) ?? null, id);
	if (changed.changes) {
		const created = member(db, id)!;
		recordMember(db, created, "create", runData(db, created, opened(db, created, now)), now);
	} else
		db.prepare("UPDATE agents SET activation_id=?, lifecycle_session_id=? WHERE id=? AND persist_events=1").run(
			context.activationId,
			context.sessionId,
			id,
		);
}
