import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { privateDir } from "../../common/src/file-mode.ts";
import { beginImmediate, loadSqlite } from "./sqlite.ts";
import { canonicalPath } from "../../common/src/canonical-path.ts";
import { AgentDbMigratingError, prepareSchema } from "./migrate.ts";
import type { MigrationContext } from "./migration-context.ts";
import { MIRROR_PLAN, SCHEMA_PLAN, type SchemaPlan } from "./migrations.ts";
import * as agentEvents from "./queries/agent-events.ts";
import { AgentDbError, COORDINATION_FILE, type FileKind } from "./schema.ts";
import { createMirrorSchema, MIRROR_APPLICATION_ID } from "./schema-mirror.ts";

/** The open SQLite handle of an agent database; features pass it to `api.ts` functions and never call it themselves. */
export type Db = DatabaseSync;

/**
 * The transcript mirror (`transcripts.db` beside the coordination file): its own connection, transactions and schema
 * version. Pass `db` to `transcripts` and `compactions` functions. Its lock is always taken before the coordination
 * file's, never inside a coordination transaction.
 */
export interface MirrorDb {
	readonly file: string;
	readonly db: Db;
	/** One BEGIN IMMEDIATE transaction of the mirror; nested calls join the outer one. */
	transaction<T>(fn: () => T): T;
}

/**
 * An open agent database: the coordination file (`db`) and, opened at its first use, the transcript mirror (`mirror`).
 * Features pass `db` to the `api.ts` query functions and group writes with `transaction`; they never write SQL themselves.
 */
export interface AgentDb {
	readonly file: string;
	/** Where the transcript mirror lives; `mirror` opens it. */
	readonly mirrorFile: string;
	/**
	 * `<Octocode home>/archive`: where housekeeping keeps history rows moved out of this database (`retention.ts`),
	 * under the home even when `OCTOCODE_AGENT_DB` names a file elsewhere. Nothing is created at open.
	 */
	readonly archiveDir: string;
	readonly db: Db;
	/** The transcript mirror, opened at first use; throws `AgentDbError` (every time) when that file cannot be used. */
	readonly mirror: MirrorDb;
	/** False when SQLite lacks FTS5: memory search falls back to LIKE. */
	readonly fts: boolean;
	/** One BEGIN IMMEDIATE transaction; nested calls join the outer one. */
	transaction<T>(fn: () => T): T;
	/** Notification after a successful outer transaction; observers cannot undo the commit. */
	onCommit(listener: () => void): () => void;
	/** After a transaction of this connection that appended agent events: their sequences, `from` to `to` inclusive. */
	onEvents(listener: (from: number, to: number) => void): () => void;
	withActor<T>(actor: { id: string; kind?: string; surface?: string }, fn: () => T): T;
	close(): void;
}

interface DatabaseLocations {
	file: string;
	/** The transcript mirror's file: the host's path helper puts it beside `file`. */
	mirrorFile: string;
	archiveDir: string;
	privateParent: boolean;
}

/** The transcript mirror file: its own header id and schema. */
const MIRROR_FILE: FileKind = {
	applicationId: MIRROR_APPLICATION_ID,
	name: "Octocode transcript mirror",
	create: createMirrorSchema,
};

/** What opening reports while a long migration runs (`MigrationContext.progress`). */
export interface OpenHooks {
	progress?(done: number, total: number): void;
}

/**
 * Open an independent connection on the coordination file; the mirror opens at its first use. The host supplies the
 * paths. Migrating a file from before version 10 moves the transcript mirror into `mirrorFile` (`mirror-move.ts`).
 */
export function openDatabase(
	locations: DatabaseLocations,
	plan: SchemaPlan = SCHEMA_PLAN,
	hooks: OpenHooks = {},
): AgentDb {
	const { file, mirrorFile, archiveDir, privateParent } = locations;
	const openMirror = () => openConnection(mirrorFile, privateParent, MIRROR_PLAN, MIRROR_FILE, { openMirror: refuse });
	const coordination = openConnection(file, privateParent, plan, COORDINATION_FILE, {
		openMirror,
		progress: hooks.progress,
	});
	let mirror: Connection | undefined;
	let refused: AgentDbError | undefined;
	const mirrorDb = (): MirrorDb => {
		if (!coordination.db.isOpen) throw new Error("The agent database is closed");
		if (refused) throw refused;
		if (!mirror?.db.isOpen) {
			try {
				mirror = openMirror();
			} catch (error) {
				if (error instanceof AgentDbError) refused = error;
				throw error;
			}
		}
		const opened = mirror;
		return {
			file: mirrorFile,
			db: opened.db,
			transaction: (fn) => {
				// Lock order: the mirror's before the coordination file's. The other way round, two processes could each
				// hold one lock and wait out their busy timeout for the other.
				if (coordination.db.isTransaction && !opened.db.isTransaction)
					throw new Error("A transcript mirror transaction cannot start inside a coordination transaction");
				return opened.transaction(fn);
			},
		};
	};
	return {
		...coordination,
		file,
		mirrorFile,
		archiveDir,
		get mirror() {
			return mirrorDb();
		},
		close: () => {
			mirror?.close();
			coordination.close();
		},
	};
}

const refuse = (): never => {
	throw new Error("The transcript mirror has no mirror of its own");
};

interface Connection {
	db: Db;
	fts: boolean;
	transaction<T>(fn: () => T): T;
	withActor<T>(actor: { id: string; kind?: string; surface?: string }, fn: () => T): T;
	onEvents(listener: (from: number, to: number) => void): () => void;
	onCommit(listener: () => void): () => void;
	close(): void;
}

/** One connection on `target`, its schema brought to `plan` for a file of `kind`. */
function openConnection(
	target: string,
	privateParent: boolean,
	plan: SchemaPlan,
	kind: FileKind,
	context: MigrationContext,
): Connection {
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
	const withActor = <T>(actor: { id: string; kind?: string; surface?: string }, fn: () => T): T => {
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
		beginImmediate(db);
		depth += 1;
		let result: T;
		// The write lock is held from here to the commit, so the events between the two reads are this transaction's own.
		let before: number | undefined;
		let after: number | undefined;
		try {
			before = appended.size > 0 ? agentEvents.head(db) : undefined;
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
		const { fts } = prepareSchema(db, target, transaction, plan, kind, context);
		db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
		tighten(target);
		let open = true;
		return {
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
/** Retry even without a write: a peer can roll back or release its lock without changing either file. */
const MIGRATION_RETRY_MS = 1_000;
/** Files another process was migrating, with their change marker and next retry time. */
const migrating = new Map<string, { error: AgentDbMigratingError; stamp: string; retryAt: number }>();

/**
 * One process connection per configured file. Opening another home must not close a database borrowed by a live
 * session. An `AgentDbError` is remembered per file and thrown again without retrying. A file another process is
 * migrating (`AgentDbMigratingError`, a busy error) is tried again once the file changes or after a short pause.
 */
export function sharedDatabase(locations: DatabaseLocations): AgentDb {
	const key = canonicalPath(locations.file);
	const current = shared.get(key);
	if (current?.db.isOpen) return current;
	const problem = refused.get(key);
	if (problem) throw problem;
	const stamp = dbStamp(locations.file);
	const waiting = migrating.get(key);
	if (waiting?.stamp === stamp && performance.now() < waiting.retryAt) throw waiting.error;
	migrating.delete(key);
	try {
		const opened = openDatabase(locations);
		shared.set(key, opened);
		return opened;
	} catch (error) {
		if (error instanceof AgentDbError) refused.set(key, error);
		if (error instanceof AgentDbMigratingError)
			migrating.set(key, { error, stamp, retryAt: performance.now() + MIGRATION_RETRY_MS });
		throw error;
	}
}

/** Closes all process-owned connections; `api.ts`'s `closeSharedAgentDb` also stops their writers (`writer/client.ts`). */
export function closeSharedConnections(): void {
	for (const connection of shared.values()) connection.close();
	shared.clear();
	refused.clear();
	migrating.clear();
}
