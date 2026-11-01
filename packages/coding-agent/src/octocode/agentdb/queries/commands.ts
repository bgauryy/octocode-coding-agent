import type { DatabaseSync } from "node:sqlite";
import { allRows } from "../rows.ts";

/** A `workspace_commands` row: the delivery receipt of one request. */
export interface CommandRow {
	id: string;
	backlog_id: string | null;
	action: string;
	input: string;
	status: string;
	at: number;
	message: string;
}

/** The latest 100 web-workspace receipts of a session, newest first. */
export function recentWorkspace(db: DatabaseSync, repo: string, session: string): CommandRow[] {
	return allRows<CommandRow>(
		db.prepare(
			"SELECT * FROM workspace_commands WHERE repo_key = ? AND session_id = ? AND action IN ('work', 'delegate', 'message', 'stop') ORDER BY at DESC LIMIT 100",
		),
		repo,
		session,
	);
}

/** The receipt of command `id` (an application command is stored as `application:<id>`), or undefined. */
export function byId(db: DatabaseSync, repo: string, session: string, id: string): CommandRow | undefined {
	return db
		.prepare("SELECT * FROM workspace_commands WHERE repo_key = ? AND session_id = ? AND id = ?")
		.get(repo, session, id) as CommandRow | undefined;
}

/** Records a web-workspace request as pending. */
export function insertPending(
	db: DatabaseSync,
	command: { id: string; session: string; repo: string; backlogId: string | null; action: string; input: string },
	at: number,
	message: string,
): void {
	db.prepare(
		"INSERT INTO workspace_commands(id, session_id, repo_key, backlog_id, action, input, status, at, message) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
	).run(command.id, command.session, command.repo, command.backlogId, command.action, command.input, at, message);
}

/** Records an application command as accepted. */
export function insertAccepted(
	db: DatabaseSync,
	command: { id: string; session: string; repo: string; action: string; input: string },
	at: number,
	message: string,
): void {
	db.prepare(
		"INSERT INTO workspace_commands(id,session_id,repo_key,action,input,status,at,message) VALUES (?,?,?,?,?,?,?,?)",
	).run(command.id, command.session, command.repo, command.action, command.input, "accepted", at, message);
}

export function setStatus(
	db: DatabaseSync,
	repo: string,
	session: string,
	id: string,
	status: string,
	message: string,
): void {
	db.prepare(
		"UPDATE workspace_commands SET status = ?, message = ? WHERE repo_key = ? AND session_id = ? AND id = ?",
	).run(status, message, repo, session, id);
}
