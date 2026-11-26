import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { privateDir } from "../../common/src/file-mode.ts";
import { beginImmediate, loadSqlite } from "./sqlite.ts";
import * as agentEvents from "./queries/agent-events.ts";
import { AgentDbError, COORDINATION_FILE, type FileKind, prepareSchema, WORKSPACE_FILE } from "./schema.ts";
import * as meta from "./queries/meta.ts";
import { needsSplit, SplitBusyError, splitWorkspaces, WORKSPACE_KEY } from "./schema-split.ts";
import * as archiveIndex from "./queries/archive-index.ts";
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
	/** The key of the workspace file this is (`DatabaseLocations.workspace`); undefined for the machine file. */
	readonly workspace: string | undefined;
	/** The machine file's folder of workspace files (`DatabaseLocations.workspaceDir`): a writer of it needs it too. */
	readonly workspaceDir: string | undefined;
	/**
	 * The file whose name tags the history rows this database archives (`history-archive.ts` `archiveSource`): the file
	 * itself, and for a workspace file the machine file, which archived the same repository's rows before the split.
	 */
	readonly historySource: string;
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

export interface DatabaseLocations {
	file: string;
	/** The transcript mirror's file: the host's path helper puts it beside the machine file. */
	mirrorFile: string;
	archiveDir: string;
	privateParent: boolean;
	/** Opens `file` as the workspace file of this key (`WORKSPACE_FILE`); a file stamped with another key is refused. */
	workspace?: string;
	/** `AgentDb.historySource`; `file` when unset. */
	historySource?: string;
	/**
	 * The machine file's folder of workspace files, named by a host with workspace files on: with it a split machine file
	 * (`schema-split.ts`) opens; without it one is refused, since this host would write workspace rows into it.
	 */
	workspaceDir?: string;
	/**
	 * Given with `workspaceDir`: an open that finds the split pending runs it first, refused while a session row names
	 * another process `running` says still runs (its pid and recorded start time). Without it a pending split is left
	 * for another opener (a writer thread). Not passed to a writer thread: it cannot be cloned.
	 */
	split?: {
		running(pid: number, started: string | null): boolean;
		/**
		 * Given: a split refused because another session's process runs is put off instead. The open keeps the un-split
		 * layout (its `workspaceDir` is unset) and this hears why; without it the refusal is thrown.
		 */
		deferred?(reason: string): void;
	};
}

/** The transcript mirror file: its own header id and schema. */
const MIRROR_FILE: FileKind = {
	applicationId: MIRROR_APPLICATION_ID,
	name: "Octocode transcript mirror",
	version: 1,
	minReader: 1,
	create: createMirrorSchema,
};

/** The archive search index: a disposable cache. */
const ARCHIVE_INDEX_FILE: FileKind = {
	applicationId: archiveIndex.APPLICATION_ID,
	name: "Octocode archive index",
	version: 1,
	minReader: 1,
	create: archiveIndex.create,
};

/** A connection on the archive index file (`queries/archive-index.ts`); `fts` is false where SQLite lacks FTS5. */
export interface ArchiveIndexDb {
	file: string;
	db: Db;
	fts: boolean;
	transaction<T>(fn: () => T): T;
	close(): void;
}

/** Opens the archive index at `file`, creating it. */
export function openArchiveIndex(file: string, waitMs = 5000): ArchiveIndexDb {
	const { db, transaction, close } = connect(file, false, ARCHIVE_INDEX_FILE, waitMs);
	return { file, db, fts: archiveIndex.hasFts(db), transaction, close };
}

/**
 * Open an independent connection on the coordination file; the mirror opens at its first use. The host supplies the
 * paths.
 */
export function openDatabase(locations: DatabaseLocations, kind: FileKind = COORDINATION_FILE): AgentDb {
	return openWithTimeout(locations, kind, 5000);
}

const mirrorOpeners = new WeakMap<AgentDb, (waitMs: number) => MirrorDb>();

/** The mirror of `agent`, opened within `waitMs` (`prepareSharedDatabase`). */
export const openMirror = (agent: AgentDb, waitMs: number): MirrorDb => mirrorOpeners.get(agent)!(waitMs);

/** A connection on the workspace file of `key`: created and stamped when empty, refused when stamped for another key. */
function connectWorkspace(file: string, privateParent: boolean, key: string, waitMs: number): Connection {
	const opened = connect(file, privateParent, WORKSPACE_FILE, waitMs);
	try {
		// Read without a lock: a stamped file (every open after the first) must open while another process writes.
		const stamped =
			meta.read(opened.db, WORKSPACE_KEY) ??
			opened.transaction(() => {
				const found = meta.read(opened.db, WORKSPACE_KEY);
				if (found === undefined) meta.write(opened.db, WORKSPACE_KEY, key);
				return found ?? key;
			});
		if (stamped !== key)
			throw new AgentDbError(`${file} is the workspace database of ${stamped}, not of ${key}; nothing in it changed.`);
		return opened;
	} catch (error) {
		opened.close();
		throw error;
	}
}

export function openWithTimeout(locations: DatabaseLocations, kind: FileKind, waitMs: number): AgentDb {
	const {
		file,
		mirrorFile,
		archiveDir,
		privateParent,
		workspace,
		workspaceDir,
		split,
		historySource = file,
	} = locations;
	const coordination =
		workspace === undefined
			? connect(file, privateParent, kind, waitMs, workspaceDir !== undefined)
			: connectWorkspace(file, privateParent, workspace, waitMs);
	let layoutDir = workspaceDir;
	if (workspaceDir !== undefined && split && workspace === undefined && needsSplit(coordination.db)) {
		try {
			splitWorkspaces(coordination.db, {
				file,
				workspaceDir,
				transaction: coordination.transaction,
				open: (target, key) => connectWorkspace(target, privateParent, key, waitMs),
				running: split.running,
			});
		} catch (error) {
			// While others run, the process keeps the un-split layout: its rows stay in the machine file, and a later
			// split moves them.
			if (!(error instanceof SplitBusyError && split.deferred)) {
				coordination.close();
				throw error;
			}
			split.deferred(error.message);
			layoutDir = undefined;
		}
	}
	let mirror: Connection | undefined;
	let refused: AgentDbError | undefined;
	const mirrorDb = (mirrorWaitMs = 5000): MirrorDb => {
		if (!coordination.db.isOpen) throw new Error("The agent database is closed");
		if (refused) throw refused;
		if (!mirror?.db.isOpen) {
			try {
				mirror = connect(mirrorFile, privateParent, MIRROR_FILE, mirrorWaitMs);
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
	const agent: AgentDb = {
		...coordination,
		file,
		mirrorFile,
		archiveDir,
		workspace,
		workspaceDir: layoutDir,
		historySource,
		get mirror() {
			return mirrorDb();
		},
		close: () => {
			mirror?.close();
			coordination.close();
		},
	};
	mirrorOpeners.set(agent, mirrorDb);
	return agent;
}

interface Connection {
	db: Db;
	fts: boolean;
	transaction<T>(fn: () => T): T;
	withActor<T>(actor: { id: string; kind?: string; surface?: string }, fn: () => T): T;
	onEvents(listener: (from: number, to: number) => void): () => void;
	onCommit(listener: () => void): () => void;
	close(): void;
}

/** `takesStep`: the opener reads a file at `kind.optionalStep`'s version (`prepareSchema`). */
function connect(
	target: string,
	privateParent: boolean,
	kind: FileKind,
	waitMs: number,
	takesStep = false,
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
		stampMemo.clear();
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
		db.exec(`PRAGMA busy_timeout=${waitMs}; PRAGMA foreign_keys=ON;`);
		const { fts } = prepareSchema(db, target, transaction, kind, takesStep);
		db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
		if (waitMs !== 5000) db.exec("PRAGMA busy_timeout=5000");
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

/** Stamps read in the current event-loop turn; emptied by a microtask and by every transaction commit of this process. */
const stampMemo = new Map<string, string>();

/**
 * A cheap change marker for the database file and its WAL: a write by any process moves it. Constant for a file that
 * does not exist. Callers of one turn (the shared clock runs the team ticker and every follower in one dispatch) share one
 * stat pair. The memo ends with the turn, and at once when this process commits a transaction, so it can lag only a
 * write made outside `transaction` in the same synchronous run; no other process's write is seen late by more than that turn.
 */
export function dbStamp(file: string): string {
	const known = stampMemo.get(file);
	if (known !== undefined) return known;
	const stamp = [file, `${file}-wal`]
		.map((entry) => {
			const stat = fs.statSync(entry, { throwIfNoEntry: false });
			return stat ? `${stat.mtimeMs}:${stat.size}` : "-";
		})
		.join("|");
	if (stampMemo.size === 0) queueMicrotask(() => stampMemo.clear());
	stampMemo.set(file, stamp);
	return stamp;
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
