import type { BacklogChange, ChangeKind } from "./backlog-change.ts";

/** The fields of a backlog audit row (db `auditAfter`) that classify reads; shared/ declares it instead of importing db. */
export interface AuditRow {
	id: number;
	backlog_id: string;
	action: string;
	entity: string;
	actor: string;
	version: number | null;
	state: string | null;
	before_state: string | null;
	assignee: string | null;
	before_assignee: string | null;
	title: string | null;
	closed: number;
	parent_ref: string | null;
	paths: string | null;
	before_paths: string | null;
	relation: string | null;
	target: string | null;
	text: string | null;
	step_state: string | null;
	before_step_state: string | null;
}

const lines = (text: string | null): string[] => (text ?? "").split("\n").filter(Boolean);

const actorOf = (json: string): { id: string; surface?: string } => {
	const parsed = JSON.parse(json) as { id?: unknown; surface?: unknown };
	return {
		id: typeof parsed.id === "string" ? parsed.id : "unknown",
		...(typeof parsed.surface === "string" ? { surface: parsed.surface } : {}),
	};
};

/** The ref a stored link target (`{"id":"B5",…}`) names. */
function targetRef(stored: string | null): string | undefined {
	if (stored === null) return undefined;
	const id = (JSON.parse(stored) as { id?: unknown }).id;
	return typeof id === "string" ? id : undefined;
}

/** How an item row moved the item: its state, holder, paths or fields. */
function itemKind(row: AuditRow): ChangeKind | undefined {
	if (row.action === "delete") return undefined;
	if (row.action === "insert") return "created";
	const ended = (state: string | null) => state === "done";
	if (ended(row.state) && !ended(row.before_state)) return row.closed === 1 ? "closed" : "done";
	if (ended(row.before_state) && !ended(row.state)) return "reopened";
	if (row.state === "ongoing" && row.before_state !== "ongoing") return "claimed";
	if (row.before_state === "ongoing" && row.state !== "ongoing") return "released";
	if (row.assignee !== row.before_assignee) return "reassigned";
	if (row.paths !== row.before_paths) return "paths_changed";
	return "edited";
}

/**
 * The change an audit row records, or undefined for a row that moves no item the readers care about (a completion,
 * a delete, another link relation, a step of a session, a row of `/web` commands). A note-only write has no item row, only its comment
 * row, and classifies as `note`.
 */
export function classify(row: AuditRow): BacklogChange | undefined {
	const actor = actorOf(row.actor);
	const head = { id: row.id, ref: row.backlog_id, by: actor.id, ...(actor.surface ? { surface: actor.surface } : {}) };
	const none = { paths: [], beforePaths: [] };
	if (row.entity === "backlog") {
		const kind = itemKind(row);
		if (!kind) return undefined;
		return {
			...head,
			kind,
			...(row.state !== null ? { state: row.state } : {}),
			...(row.before_state !== null ? { beforeState: row.before_state } : {}),
			assignee: row.assignee,
			beforeAssignee: row.before_assignee,
			parent: row.parent_ref,
			paths: lines(row.paths),
			beforePaths: lines(row.before_paths),
			...(row.title !== null ? { title: row.title } : {}),
			...(row.version !== null ? { version: row.version } : {}),
		};
	}
	if (row.entity === "backlog_comments" && row.action === "insert")
		return { ...head, kind: "note", ...none, ...(row.text !== null ? { text: row.text } : {}) };
	if (row.entity === "backlog_links" && row.relation === "depends_on" && row.action !== "update") {
		const target = targetRef(row.target);
		return { ...head, kind: row.action === "insert" ? "blocked" : "unblocked", ...none, ...(target ? { target } : {}) };
	}
	// A step of an item (a session's steps have `T` refs): added, or moved to another state.
	if (row.entity === "backlog_tasks" && row.backlog_id.startsWith("B") && row.action !== "delete") {
		if (row.action === "update" && row.step_state === row.before_step_state) return undefined;
		return { ...head, kind: "step", ...none };
	}
	return undefined;
}
