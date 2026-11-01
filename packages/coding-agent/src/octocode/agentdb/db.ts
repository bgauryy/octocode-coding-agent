import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { agentDbPath, globalPaths, privateDir } from "../shared/home.ts";
import { loadSqlite } from "./sqlite.ts";
import { canonicalPath } from "../shared/home/repo.ts";
import * as backlog from "./queries/backlog.ts";
import { AgentDbError, ensureSchema, schemaCurrent } from "./schema.ts";

/** The open SQLite handle of an agent database; features pass it to `agentdb/api.ts` functions and never call it themselves. */
export type Db = DatabaseSync;

/**
 * An open agent database. Features pass `db` to the `agentdb/api.ts` query functions and group writes with
 * `transaction`; they never write SQL themselves.
 */
export interface AgentDb {
	readonly file: string;
	/**
	 * `<Octocode home>/archive`: where housekeeping keeps history rows moved out of this database (`backlog/retention.ts`),
	 * under the home even when `OCTOCODE_AGENT_DB` names a file elsewhere. Nothing is created at open.
	 */
	readonly archiveDir: string;
	readonly db: Db;
	/** False when SQLite lacks FTS5: memory search falls back to LIKE. */
	readonly fts: boolean;
	/** One BEGIN IMMEDIATE transaction; nested calls join the outer one. */
	transaction<T>(fn: () => T): T;
	withActor<T>(actor: { id: string; kind?: string }, fn: () => T): T;
	close(): void;
}

/**
 * Opens (creating, owner-only) the agent database at `file` (default `agentDbPath(env)`) and adds what the one schema has
 * and the file lacks. Throws `AgentDbError` for a file that is not ours.
 */
export function openAgentDb(file?: string, env: NodeJS.ProcessEnv = process.env): AgentDb {
	const target = file ?? agentDbPath(env);
	// Private to this user: it holds prompts, notes and memories. SQLite gives its -wal and -shm files the same mode.
	// Our own folder is tightened when it already exists; a folder named by OCTOCODE_AGENT_DB is only created.
	if (target === path.join(globalPaths(env).agentState, "octocode.db")) privateDir(path.dirname(target));
	else fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	fs.closeSync(fs.openSync(target, "a", 0o600));
	const { DatabaseSync: Database } = loadSqlite();
	const db = new Database(target);
	db.function("octocode_backlog_writer", () => 1);
	let auditActor = JSON.stringify({ id: "system", kind: "system" });
	db.function("octocode_audit_actor", () => auditActor);
	const withActor = <T>(actor: { id: string; kind?: string }, fn: () => T): T => {
		const previous = auditActor;
		auditActor = JSON.stringify(actor);
		try {
			return fn();
		} finally {
			auditActor = previous;
		}
	};
	let depth = 0;
	const transaction = <T>(fn: () => T): T => {
		if (depth > 0) return fn();
		db.exec("BEGIN IMMEDIATE");
		depth += 1;
		try {
			const result = fn();
			db.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// SQLite already rolled back (some errors do); the failure to report is the original.
			}
			throw error;
		} finally {
			depth -= 1;
		}
	};
	try {
		// Nothing that changes the file (journal mode included) before ensureSchema has checked it is ours or new. A file
		// that already has the whole schema is opened without a write lock; otherwise the additions are made under one,
		// checked again there (another process may have just made them).
		db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
		const { fts } = schemaCurrent(db) ? { fts: true } : transaction(() => ensureSchema(db, target));
		db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
		// Comments replaced the backlog notes of kind `note`; rows written by an older build are copied across once.
		if (backlog.hasUncopiedNotes(db)) transaction(() => backlog.copyNotesToComments(db));
		// The item type `task` was renamed `feature`; an older build still running (or an existing file's column default,
		// which a schema sync cannot change) writes `task` again, so every open rewrites whatever rows it finds. The check
		// takes no write lock. Best effort: a locked file keeps its rows (every read maps `task` to `feature`); the next open retries.
		try {
			if (backlog.hasLegacyItemType(db)) transaction(() => backlog.renameLegacyItemType(db));
		} catch {
			// Busy or read-only: not a reason to fail the open.
		}
		tighten(target);
		let open = true;
		return {
			file: target,
			archiveDir: path.join(globalPaths(env).home, "archive"),
			db,
			fts,
			transaction,
			withActor,
			close: () => {
				if (open) db.close();
				open = false;
			},
		};
	} catch (error) {
		db.close();
		if (isNotADatabase(error))
			throw new AgentDbError(`${target} is not an SQLite database; set OCTOCODE_AGENT_DB to another file.`);
		throw error;
	}
}

/** A cheap change marker for the database file and its WAL: a write by any process moves it. Constant for a file that does not exist. */
export function dbStamp(file: string): string {
	return [file, `${file}-wal`]
		.map((entry) => {
			const stat = fs.statSync(entry, { throwIfNoEntry: false });
			return stat ? `${stat.mtimeMs}:${stat.size}` : "-";
		})
		.join("|");
}

/** SQLITE_NOTADB (26): the file has no SQLite header. */
const isNotADatabase = (error: unknown) => (error as { errcode?: number } | null)?.errcode === 26;

/** Owner-only modes for an existing database of ours and its WAL files (an older or copied file may be looser). */
function tighten(target: string): void {
	for (const each of [target, `${target}-wal`, `${target}-shm`]) {
		try {
			if ((fs.statSync(each).mode & 0o077) !== 0) fs.chmodSync(each, 0o600);
		} catch {
			// Missing, or not ours to change.
		}
	}
}

const shared = new Map<string, AgentDb>();
const refused = new Map<string, AgentDbError>();

/**
 * One process connection per configured file. Opening another home must not close a database borrowed by a live
 * session. An `AgentDbError` is remembered per file and thrown again without retrying.
 */
export function sharedAgentDb(env: NodeJS.ProcessEnv = process.env): AgentDb {
	const file = agentDbPath(env);
	const key = canonicalPath(file);
	const current = shared.get(key);
	if (current) return current;
	const problem = refused.get(key);
	if (problem) throw problem;
	try {
		const opened = openAgentDb(file, env);
		shared.set(key, opened);
		return opened;
	} catch (error) {
		if (error instanceof AgentDbError) refused.set(key, error);
		throw error;
	}
}

/** Closes all process-owned agent databases (tests, process exit); the next access opens a fresh connection. */
export function closeSharedAgentDb(): void {
	for (const connection of shared.values()) connection.close();
	shared.clear();
	refused.clear();
}
