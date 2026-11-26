import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type AgentDb, type DatabaseLocations, openDatabase } from "../src/db.ts";
import { WORKSPACE_TABLES } from "../src/schema-split.ts";
import { loadSqlite } from "../src/sqlite.ts";
import { tmp } from "./helpers.ts";

export const { DatabaseSync } = loadSqlite();

export const where = (file: string, extra: Partial<DatabaseLocations> = {}): DatabaseLocations => ({
	file,
	mirrorFile: path.join(path.dirname(file), "transcripts.db"),
	archiveDir: path.join(path.dirname(file), "archive"),
	privateParent: false,
	...extra,
});
export const dirOf = (file: string) => path.join(path.dirname(file), "workspaces");

/** An open by a host with workspace files on: it splits a pending file, judging other sessions' pids by `running`. */
export const openMachine = (file: string, running: (pid: number, started: string | null) => boolean = () => false) =>
	openDatabase(where(file, { workspaceDir: dirOf(file), split: { running } }));

export function rows<T>(file: string, sql: string): T[] {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return db.prepare(sql).all() as T[];
	} finally {
		db.close();
	}
}
export const count = (file: string, table: string) =>
	rows<{ n: number }>(file, `SELECT count(*) AS n FROM ${table}`)[0].n;
export const counts = (file: string) =>
	Object.fromEntries(WORKSPACE_TABLES.map((table) => [table, count(file, table)]));
export const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
export const versionOf = (file: string) => rows<{ user_version: number }>(file, "PRAGMA user_version")[0].user_version;
export const minReaderOf = (file: string) =>
	rows<{ min_reader: number }>(file, "SELECT min_reader FROM schema_meta")[0].min_reader;

/** One workspace's rows across the workspace-owned tables: an item with a note, link and task, team rows and history. */
export function seed(db: AgentDb["db"], ws: string, team: string, n: number): void {
	db.exec(`INSERT INTO backlog (workspace_id, seq, title, state, created_by, created_at, updated_at)
			VALUES ('${ws}', 1, 'item of ${ws}', 'todo', 'user', ${n}, ${n});
		INSERT INTO backlog_notes (item, at, author, text) SELECT id, ${n}, 'user', 'note' FROM backlog WHERE workspace_id = '${ws}';
		INSERT INTO backlog_links (item, relation, target) SELECT id, 'output', '"x"' FROM backlog WHERE workspace_id = '${ws}';
		INSERT INTO backlog_tasks (workspace_id, seq, item_id, goal, created_at, updated_at)
			SELECT '${ws}', 1, id, 'step', ${n}, ${n} FROM backlog WHERE workspace_id = '${ws}';
		INSERT INTO agents (id, team, workspace_id, role, pid, status, joined_at, seen_at)
			VALUES ('agent-${ws}', '${team}', '${ws}', 'main', 1, 'idle', ${n}, ${n});
		INSERT INTO messages (team, workspace_id, sender, body, created_at) VALUES ('${team}', '${ws}', 'agent-${ws}', 'hi', ${n});
		INSERT INTO deliveries (message, recipient) SELECT max(id), 'agent-${ws}' FROM messages;
		INSERT INTO agent_events (id, workspace_id, time, type, data, version) VALUES ('e-${ws}', '${ws}', 't', 'joined', '{}', 1);
		INSERT INTO timers (workspace_id, session_id, note, kind, due_at, created_at, updated_at)
			VALUES ('${ws}', 's-${ws}', 'wake', 'once', ${n}, ${n}, ${n});
		INSERT INTO event_log (workspace_id, at, topic, key, source, payload, digest)
			VALUES ('${ws}', ${n}, 'item', 'B1', 'test', '{}', 'd');
		INSERT INTO leases (workspace_id, path, path_key, kind, owner, reason, acquired_at, expires_at)
			VALUES ('${ws}', 'a.ts', 'a.ts', 'file', 'agent-${ws}', 'edit', ${n}, ${n + 1});
		INSERT INTO sessions (id, workspace_id) VALUES ('s-${ws}', '${ws}');`);
}

/**
 * A version-11 machine file: repository `/r` (main checkout `main`, linked worktree `wt`) and folder `/b` outside Git,
 * each with rows in every family, plus machine-wide rows (memories, sessions) that stay.
 */
export function version11(): string {
	const file = path.join(tmp(), "workspaces.db");
	const agent = openDatabase(where(file));
	agent.db.exec(`INSERT INTO workspaces (id, name, root, binding, git_common_dir, linked_worktree) VALUES
			('wt', 'wt', '/wt', 'b1', '/r/.git', 1), ('main', 'r', '/r', 'b2', '/r/.git', 0), ('solo', 'b', '/b', 'b3', NULL, NULL);
		INSERT INTO memories (scope, title, author, created_at, updated_at) VALUES ('global', 'kept', 'user', 1, 1);
		INSERT INTO memories (scope, repo_key, title, author, created_at, updated_at) VALUES ('project', '/r/.git', 'kept too', 'user', 1, 1);`);
	seed(agent.db, "main", "/r/.git", 1);
	seed(agent.db, "wt", "/r/.git", 2);
	seed(agent.db, "solo", "/b", 3);
	agent.db.exec(
		"ALTER TABLE workspaces DROP COLUMN db_key; UPDATE schema_meta SET min_reader = 10; PRAGMA user_version=11",
	);
	agent.close();
	return file;
}

/** `version11` opened once by a host with workspace files off: a version-12 file that was never split. */
export function version12(): string {
	const file = version11();
	openDatabase(where(file)).close();
	return file;
}

/** Writes `sql` to `file` as a process that opened it before the split would: no version check, closed at once. */
export function write(file: string, sql: string): void {
	const db = new DatabaseSync(file);
	// The functions the audit triggers call, as every Octocode connection registers them.
	db.function("octocode_backlog_writer", () => 1);
	db.function("octocode_audit_actor", () => JSON.stringify({ id: "system", kind: "system" }));
	try {
		db.exec(sql);
	} finally {
		db.close();
	}
}

/** Puts the closed machine file back as `copy` holds it (a restored backup), without its write-ahead files. */
export function restore(file: string, copy: string): void {
	fs.copyFileSync(copy, file);
	for (const suffix of ["-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
}
