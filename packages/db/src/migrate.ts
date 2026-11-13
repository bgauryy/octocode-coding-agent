import fs from "node:fs";
import { threadId } from "node:worker_threads";
import type { DatabaseSync } from "node:sqlite";
import type { MigrationContext } from "./migration-context.ts";
import { type Migration, readableFromFor, type SchemaPlan } from "./migrations.ts";
import * as maintenance from "./queries/maintenance.ts";
import * as schemaVersion from "./queries/schema-version.ts";
import { AgentDbError, createSchema, type FileKind, schemaState } from "./schema.ts";
import { isBusy, loadSqlite, withBusyTimeout } from "./sqlite.ts";

type Transaction = <T>(fn: () => T) => T;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The `user_version` in a database file's header (big-endian, at byte 60), read without opening a connection on it. */
function fileVersion(file: string): number {
	const header = Buffer.alloc(4);
	const fd = fs.openSync(file, "r");
	try {
		fs.readSync(fd, header, 0, 4, 60);
	} finally {
		fs.closeSync(fd);
	}
	return header.readInt32BE(0);
}

/**
 * The write lock is held: another process migrating the file (a long step, such as the version 10 move of the transcript
 * mirror). SQLite's busy code (`isBusy`), so callers treat it as a database that is busy for now; `sharedDatabase`
 * remembers it until the file changes or the retry delay passes rather than waiting again on every call.
 */
export class AgentDbMigratingError extends Error {
	readonly errcode = 5;
}

/** How long opening an old file waits for its write lock before it reports `AgentDbMigratingError`: a short step's commit, not a long one. */
const CLAIM_BUSY_MS = 250;

/** Creates `partial` for this thread alone; a file left by an ended run under the same name is removed first. */
function createPrivate(partial: string): void {
	try {
		fs.closeSync(fs.openSync(partial, "wx", 0o600));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		// Same pid and thread: only an ended run can have left it. A folder is not removed, and the backup fails.
		fs.rmSync(partial);
		fs.closeSync(fs.openSync(partial, "wx", 0o600));
	}
}

/** Flushes a finished copy to disk before it is renamed over the backup it replaces. */
function syncFile(file: string): void {
	const fd = fs.openSync(file, "r+");
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Saves `<file>.v<version>.bak` before a migration, and returns its path. Other live sessions write this WAL database, so
 * only `VACUUM INTO` gives a consistent copy; a plain file copy would miss or tear what the WAL holds. The copy is read
 * through a connection of its own, so the caller may hold the write lock (a migration takes the backup inside its first
 * step's transaction). The newest complete snapshot of a version replaces an older one of that version, so failed
 * attempts do not pile up copies of a large file; a copy replaces it only once it is whole and on disk. Each thread
 * writes its own temporary file. Returns undefined when another process migrated before the snapshot began: it no
 * longer shows `version`, and that process's own backup does. The pending steps' `backup` filters then trim the copy.
 */
export function backUp(file: string, version: number, pending: readonly Migration[] = []): string | undefined {
	const target = `${file}.v${version}.bak`;
	const partial = `${target}.${process.pid}.${threadId}.tmp`;
	let created = false;
	try {
		// Prompts and memories are private: VACUUM INTO would create the file from the umask, but it fills an empty one.
		createPrivate(partial);
		created = true;
		const { DatabaseSync: Database } = loadSqlite();
		const reader = new Database(file);
		try {
			schemaVersion.vacuumInto(reader, partial);
		} finally {
			reader.close();
		}
		if (fileVersion(partial) !== version) {
			fs.rmSync(partial, { force: true });
			return undefined;
		}
		const copy = new Database(partial);
		try {
			for (const step of pending) step.backup?.(copy);
			if (!schemaVersion.wholeCopy(copy)) throw new Error("the copy is not a whole database");
		} finally {
			copy.close();
		}
		syncFile(partial);
		fs.renameSync(partial, target);
		return target;
	} catch (error) {
		if (created) fs.rmSync(partial, { force: true });
		if (isBusy(error)) throw error;
		throw new AgentDbError(
			`${file} needs a migration from schema version ${version}, and its backup failed: ${message(error)}. Nothing in the file changed.`,
		);
	}
}

/**
 * Applies the steps from the file's version up to the plan's, each in its own `BEGIN IMMEDIATE` transaction, so a failure
 * leaves the file at the last version that completed. The version is read again once the lock is held, because another
 * process may have run the same step while this one waited for it. The first step's lock is taken before anything else:
 * the backup is decided and written under it, so a process that finds another one migrating backs up nothing and waits
 * only briefly (`AgentDbMigratingError`).
 */
function migrate(
	db: DatabaseSync,
	file: string,
	transaction: Transaction,
	plan: SchemaPlan,
	context: MigrationContext,
) {
	let backup: string | undefined;
	for (let first = true; ; first = false) {
		let locked = false;
		const run = () =>
			transaction(() => {
				locked = true;
				const from = schemaVersion.current(db);
				if (from >= plan.version) return true;
				const step = plan.migrations.find((candidate) => candidate.to === from + 1);
				if (!step) throw new AgentDbError(`${file} is at schema version ${from}, and no migration leads from it.`);
				if (first)
					backup = backUp(
						file,
						from,
						plan.migrations.filter((candidate) => candidate.to > from),
					);
				try {
					step.up(db, context);
					schemaVersion.setReadableFrom(db, readableFromFor(plan, step.to));
					schemaVersion.set(db, step.to);
				} catch (error) {
					const saved = backup ? ` A backup is at ${backup}.` : "";
					throw new AgentDbError(
						`${file} could not migrate from schema version ${from} to ${from + 1}: ${message(error)}. It stays at version ${from}, with its data.${saved}`,
					);
				}
				return step.to >= plan.version;
			});
		let done: boolean;
		try {
			done = first ? withBusyTimeout(db, CLAIM_BUSY_MS, run) : run();
		} catch (error) {
			if (first && !locked && isBusy(error))
				throw new AgentDbMigratingError(
					`${file} is being migrated by another process; Octocode uses it once that migration ends.`,
					{ cause: error },
				);
			throw error;
		}
		if (done) return;
	}
}

/**
 * Brings the open database to the plan's shape and returns its FTS capability: nothing for a current file, creation for
 * an empty one, a backup and the migration steps for an older one, then `VACUUM` when a step that ran asks for it. A file
 * that cannot be used throws `AgentDbError` before anything in it changes; one another process is migrating throws
 * `AgentDbMigratingError`. Each case is decided again under its lock.
 */
export function prepareSchema(
	db: DatabaseSync,
	file: string,
	transaction: Transaction,
	plan: SchemaPlan,
	kind: FileKind,
	context: MigrationContext,
): { fts: boolean } {
	for (;;) {
		const state = schemaState(db, file, plan, kind);
		if (state.status === "current") return { fts: state.fts };
		if (state.status === "empty") {
			const created = transaction(() =>
				schemaState(db, file, plan, kind).status === "empty" ? createSchema(db, plan, kind) : undefined,
			);
			if (created) return created;
			continue;
		}
		const pending = plan.migrations.filter((step) => step.to > state.version);
		migrate(db, file, transaction, plan, context);
		// Space the steps freed; a file another process holds open stays as it is (`busy`) and keeps working.
		if (pending.some((step) => step.vacuum)) maintenance.vacuum(db);
	}
}
