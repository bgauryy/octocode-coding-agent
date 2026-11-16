import type { DatabaseSync } from "node:sqlite";
import { num, type Row } from "../rows.ts";
import { type AgentRun, latest, openForItems } from "./agent-runs.ts";

/** A backlog item as an agent is linked to it: where it lives, its number and how to write it from the caller's workspace. */
export interface ItemLinkRef {
	workspaceId: string;
	seq: number;
	/** `B36` in the caller's workspace, `<workspace name>:B36` elsewhere (`itemRef`). */
	ref: string;
}

/** One agent, live or past, as `resolveAgent` found it. */
export interface ResolvedAgent {
	agentId: string;
	/** Whether an `agents` row exists now. */
	live: boolean;
	status?: "idle" | "working";
	role: string | undefined;
	parentAgentId: string | undefined;
	sessionId: string | undefined;
	pid: number | undefined;
	processTitle: string | undefined;
	cwd: string | undefined;
	branch: string | undefined;
	model: string | undefined;
	goal: string | undefined;
	backlog: ItemLinkRef | undefined;
	/** The session file of its conversation, when its session row knows one. */
	sessionFile: string | undefined;
	/** Its latest run: the registration, how it ended, what it cost. */
	run: AgentRun | undefined;
}

const ITEM = /^(?:(.+):)?B(\d+)$/i;
const INTEGER = /^\d+$/;

/**
 * A backlog item reference as written: `B36` (in `workspaceId`, or in any workspace when none is given) or
 * `<workspace name>:B36` (a workspace of that name, or its id). Undefined when `ref` is not one.
 */
export function parseItemRef(
	db: DatabaseSync,
	ref: string,
	workspaceId?: string,
): { workspaceIds: string[]; seq: number } | undefined {
	const match = ITEM.exec(ref.trim());
	if (!match) return undefined;
	const seq = Number(match[2]);
	if (match[1] === undefined) {
		if (workspaceId) return { workspaceIds: [workspaceId], seq };
		return {
			workspaceIds: (db.prepare("SELECT DISTINCT workspace_id AS id FROM backlog WHERE seq = ?").all(seq) as Row[]).map(
				(row) => String(row.id),
			),
			seq,
		};
	}
	const named = db.prepare("SELECT id FROM workspaces WHERE name = ? OR id = ?").all(match[1], match[1]) as Row[];
	return { workspaceIds: named.map((row) => String(row.id)), seq };
}

/** Item `seq` of `workspaceId` written for a reader in `current`: `B36` there, `<workspace name>:B36` elsewhere (the workspace id when it has no row). */
export function itemRef(db: DatabaseSync, workspaceId: string, seq: number, current?: string): string {
	if (workspaceId === current) return `B${seq}`;
	const name = db.prepare("SELECT name FROM workspaces WHERE id = ?").get(workspaceId)?.name;
	return `${typeof name === "string" ? name : workspaceId}:B${seq}`;
}

const first = (db: DatabaseSync, sql: string, ...values: Array<string | number>): string | undefined => {
	const value = Object.values(db.prepare(sql).get(...values) ?? {})[0];
	return typeof value === "string" ? value : undefined;
};

/** The agent name `ref` names among the live agents: by name, registration or session id, process title, pid, or the item it works for. */
function liveName(db: DatabaseSync, ref: string, item: ReturnType<typeof parseItemRef>): string | undefined {
	const byColumn = (column: string) =>
		first(db, `SELECT id FROM agents WHERE ${column} = ? ORDER BY joined_at DESC LIMIT 1`, ref);
	return (
		byColumn("id") ??
		byColumn("registration_id") ??
		byColumn("lifecycle_session_id") ??
		byColumn("session_id") ??
		byColumn("process_title") ??
		(INTEGER.test(ref)
			? first(db, "SELECT id FROM agents WHERE pid = ? ORDER BY joined_at DESC LIMIT 1", Number(ref))
			: undefined) ??
		// The child working on the item, by the plan view's own rule (`openForItems`).
		(item
			? item.workspaceIds.map((workspace) => openForItems(db, workspace, [item.seq])[0]?.agentId).find(Boolean)
			: undefined)
	);
}

/** The agent name `ref` names among the runs that ended, newest first: the same kinds of reference. */
function pastName(db: DatabaseSync, ref: string, item: ReturnType<typeof parseItemRef>): string | undefined {
	const byColumn = (column: string) =>
		first(db, `SELECT agent_id FROM agent_runs WHERE ${column} = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`, ref);
	return (
		byColumn("agent_id") ??
		byColumn("run_id") ??
		byColumn("registration_id") ??
		byColumn("session_id") ??
		byColumn("process_title") ??
		(INTEGER.test(ref)
			? first(
					db,
					"SELECT agent_id FROM agent_runs WHERE pid = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
					Number(ref),
				)
			: undefined) ??
		(item
			? item.workspaceIds
					.map((workspace) =>
						first(
							db,
							"SELECT agent_id FROM agent_runs WHERE backlog_workspace = ? AND backlog_seq = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
							workspace,
							item.seq,
						),
					)
					.find((name) => name !== undefined)
			: undefined)
	);
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Finds an agent by any name it goes by: its name, session id, registration or run id, process title, pid,
 * or a backlog item it works or worked for (`B36`, `<workspace name>:B36`). A live agent answers first, then the latest
 * run of a past one; a name reused since answers with its newest run. `workspaceId` is the caller's, for unqualified items.
 */
export function resolveAgent(db: DatabaseSync, ref: string, workspaceId?: string): ResolvedAgent | undefined {
	const wanted = ref.trim();
	if (!wanted) return undefined;
	const item = parseItemRef(db, wanted, workspaceId);
	const agentId = liveName(db, wanted, item) ?? pastName(db, wanted, item);
	if (!agentId) return undefined;
	const live = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
	const run = latest(db, agentId);
	const session = text(live?.lifecycle_session_id) ?? text(live?.session_id) ?? run?.sessionId;
	const backlog = run?.backlog ?? mainItem(db, run, session);
	return {
		agentId,
		live: live !== undefined && live.status !== "settled",
		...(live ? { status: live.status === "working" ? ("working" as const) : ("idle" as const) } : {}),
		role: text(live?.role) ?? run?.profile,
		parentAgentId: text(live?.parent_id) ?? run?.parentAgentId,
		sessionId: session,
		pid: live ? num(live.pid) : run?.pid,
		processTitle: text(live?.process_title) ?? run?.processTitle,
		cwd: text(live?.cwd) ?? run?.cwd,
		branch: text(live?.branch) ?? run?.branch,
		model: text(live?.model) ?? run?.model,
		goal: text(live?.task) ?? run?.goal,
		backlog: backlog ? { ...backlog, ref: itemRef(db, backlog.workspaceId, backlog.seq, workspaceId) } : undefined,
		sessionFile: session ? text(db.prepare("SELECT file FROM sessions WHERE id = ?").get(session)?.file) : undefined,
		run,
	};
}

/** A main session's item: the ongoing one its session holds (`backlog.assignee` is the session id). */
function mainItem(
	db: DatabaseSync,
	run: AgentRun | undefined,
	session: string | undefined,
): { workspaceId: string; seq: number } | undefined {
	if (run?.kind !== "main" || !session) return undefined;
	const row = db
		.prepare(
			"SELECT workspace_id, seq FROM backlog WHERE assignee = ? AND state = 'ongoing' ORDER BY updated_at DESC LIMIT 1",
		)
		.get(session);
	return row ? { workspaceId: String(row.workspace_id), seq: num(row.seq) } : undefined;
}
