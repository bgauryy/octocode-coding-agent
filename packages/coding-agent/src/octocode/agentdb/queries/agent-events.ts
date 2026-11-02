import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Row } from "../rows.ts";

export const EVENT_TYPES = ["init", "create", "update", "delete", "compaction"] as const;
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
}

export function append(db: DatabaseSync, workspace: string, event: AgentEvent, key?: string): void {
	db.prepare(`INSERT INTO agent_events(id, workspace, time, name, parent_id, session_id, type, data, version, event_key)
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
		workspace: String(row.workspace),
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
	const clauses = ["workspace = ?", "seq < ?"];
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

export function get(db: DatabaseSync, workspace: string, id: string): EventRow | undefined {
	const row = db.prepare("SELECT * FROM agent_events WHERE workspace = ? AND id = ?").get(workspace, id) as
		| Row
		| undefined;
	return row ? decode(row) : undefined;
}

export function member(db: DatabaseSync, id: string): Row | undefined {
	return db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
}

/** Called in the presence mutation's transaction. A null registration marks nonpersistent/legacy presence. */
export function recordMember(
	db: DatabaseSync,
	row: Row,
	type: "create" | "update" | "delete",
	data: Record<string, unknown>,
	now: number,
): void {
	if (typeof row.registration_id !== "string" || !row.persist_events) return;
	const registrationId = row.registration_id;
	append(db, String(row.checkout), {
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
	});
}

export function registerMember(db: DatabaseSync, id: string, context: LifecycleContext | undefined, now: number): void {
	if (!context) return;
	const row = member(db, id);
	const parent = typeof row?.parent_id === "string" ? member(db, row.parent_id) : undefined;
	const changed = db
		.prepare(`UPDATE agents SET registration_id = ?, persist_events = 1, activation_id = ?, lifecycle_session_id = ?, parent_registration_id = ?
		WHERE id = ? AND registration_id IS NULL`)
		.run(randomUUID(), context.activationId, context.sessionId, (parent?.registration_id as string | null) ?? null, id);
	if (changed.changes) recordMember(db, member(db, id)!, "create", {}, now);
	else
		db.prepare("UPDATE agents SET activation_id=?, lifecycle_session_id=? WHERE id=? AND persist_events=1").run(
			context.activationId,
			context.sessionId,
			id,
		);
}
