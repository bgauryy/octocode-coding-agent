import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { privateDir } from "../../common/src/file-mode.ts";
import { loadSqlite } from "./sqlite.ts";
import { canonicalPath } from "../../common/src/canonical-path.ts";
import { prepareSchema } from "./migrate.ts";
import { SCHEMA_PLAN, type SchemaPlan } from "./migrations.ts";
import * as agentEvents from "./queries/agent-events.ts";
import { AgentDbError } from "./schema.ts";

/** The open SQLite handle of an agent database; features pass it to `api.ts` functions and never call it themselves. */
export type Db = DatabaseSync;

/**
 * An open agent database. Features pass `db` to the `api.ts` query functions and group writes with
 * `transaction`; they never write SQL themselves.
 */
export interface AgentDb {
	readonly file: string;
	/**
	 * `<Octocode home>/archive`: where housekeeping keeps history rows moved out of this database (`retention.ts`),
	 * under the home even when `OCTOCODE_AGENT_DB` names a file elsewhere. Nothing is created at open.
	 */
	readonly archiveDir: string;
	readonly db: Db;
	/** False when SQLite lacks FTS5: memory search falls back to LIKE. */
	readonly fts: boolean;
	/** One BEGIN IMMEDIATE transaction; nested calls join the outer one. */
	transaction<T>(fn: () => T): T;
	/** Notification after a successful outer transaction; observers cannot undo the commit. */
	onCommit(listener: () => void): () => void;
	/** After a transaction of this connection that appended agent events: their sequences, `from` to `to` inclusive. */
	onEvents(listener: (from: number, to: number) => void): () => void;
	withActor<T>(actor: { id: string; kind?: string }, fn: () => T): T;
	close(): void;
}

interface DatabaseLocations {
	file: string;
	archiveDir: string;
	privateParent: boolean;
}

/** Open an independent connection. The host supplies the database and archive paths. */
export function openDatabase(
	{ file: target, archiveDir, privateParent }: DatabaseLocations,
	plan: SchemaPlan = SCHEMA_PLAN,
): AgentDb {
	// Private to this user: it holds prompts, notes and memories. SQLite gives its -wal and -shm files the same mode.
	// Our own folder is tightened when it already exists; a folder named by OCTOCODE_AGENT_DB is only created.
	if (privateParent) privateDir(path.dirname(target));
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
	const committed = new Set<() => void>();
	const appended = new Set<(from: number, to: number) => void>();
	let depth = 0;
	const transaction = <T>(fn: () => T): T => {
		if (depth > 0) return fn();
		db.exec("BEGIN IMMEDIATE");
		depth += 1;
		let result: T;
		// The write lock is held from here to the commit, so the events between the two reads are this transaction's own.
		const before = appended.size > 0 ? agentEvents.head(db) : undefined;
		let after = before;
		try {
			result = fn();
			if (before !== undefined) after = agentEvents.head(db);
			db.exec("COMMIT");
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				/* SQLite may already have rolled back. */
			}
			throw error;
		} finally {
			depth -= 1;
		}
		if (before !== undefined && after !== undefined && after > before)
			for (const listener of appended) {
				try {
					listener(before + 1, after);
				} catch {
					/* An observer cannot undo a completed transaction. */
				}
			}
		for (const listener of committed) {
			try {
				listener();
			} catch {
				/* An observer cannot undo a completed transaction. */
			}
		}
		return result;
	};
	try {
		db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
		const { fts } = prepareSchema(db, target, transaction, plan);
		db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
		tighten(target);
		let open = true;
		return {
			file: target,
			archiveDir,
			db,
			fts,
			transaction,
			withActor,
			onEvents: (listener) => {
				appended.add(listener);
				return () => {
					appended.delete(listener);
				};
			},
			onCommit: (listener) => {
				committed.add(listener);
				return () => {
					committed.delete(listener);
				};
			},
			close: () => {
				committed.clear();
				appended.clear();
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
export function sharedDatabase(locations: DatabaseLocations): AgentDb {
	const key = canonicalPath(locations.file);
	const current = shared.get(key);
	if (current) return current;
	const problem = refused.get(key);
	if (problem) throw problem;
	try {
		const opened = openDatabase(locations);
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
