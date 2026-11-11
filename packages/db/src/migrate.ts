import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { readableFromFor, type SchemaPlan } from "./migrations.ts";
import * as schemaVersion from "./queries/schema-version.ts";
import { AgentDbError, createSchema, schemaState } from "./schema.ts";
import { isBusy } from "./sqlite.ts";

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
 * Saves `<file>.v<version>.bak` before a migration, and returns its path. Other live sessions write this WAL database, so
 * only `VACUUM INTO` gives a consistent copy; a plain file copy would miss or tear what the WAL holds. The newest
 * complete snapshot of a version replaces an older one of that version, so failed attempts do not pile up copies of a
 * large file. Returns undefined when another process migrated before the snapshot began: it no longer shows `version`,
 * and that process's own backup does.
 */
export function backUp(db: DatabaseSync, file: string, version: number): string | undefined {
	const target = `${file}.v${version}.bak`;
	const partial = `${target}.${process.pid}.tmp`;
	try {
		// Prompts and memories are private: VACUUM INTO would create the file from the umask, but it fills an empty one.
		fs.closeSync(fs.openSync(partial, "w", 0o600));
		schemaVersion.vacuumInto(db, partial);
		if (fileVersion(partial) !== version) {
			fs.rmSync(partial, { force: true });
			return undefined;
		}
		fs.renameSync(partial, target);
		return target;
	} catch (error) {
		fs.rmSync(partial, { recursive: true, force: true });
		if (isBusy(error)) throw error;
		throw new AgentDbError(
			`${file} needs a migration from schema version ${version}, and its backup failed: ${message(error)}. Nothing in the file changed.`,
		);
	}
}

/**
 * Applies the steps from the file's version up to the plan's, each in its own `BEGIN IMMEDIATE` transaction, so a failure
 * leaves the file at the last version that completed. The version is read again once the lock is held, because another
 * process may have run the same step while this one waited for it.
 */
function migrate(db: DatabaseSync, file: string, transaction: Transaction, plan: SchemaPlan, backup?: string): void {
	for (;;) {
		const done = transaction(() => {
			const from = schemaVersion.current(db);
			if (from >= plan.version) return true;
			const step = plan.migrations.find((candidate) => candidate.to === from + 1);
			if (!step) throw new AgentDbError(`${file} is at schema version ${from}, and no migration leads from it.`);
			try {
				step.up(db);
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
		if (done) return;
	}
}

/**
 * Brings the open database to the plan's shape and returns its FTS capability: nothing for a current file, creation for
 * an empty one, a backup and the migration steps for an older one. A file that cannot be used throws `AgentDbError`
 * before anything in it changes. A backup cannot run inside a transaction, so each case is decided again after its lock.
 */
export function prepareSchema(
	db: DatabaseSync,
	file: string,
	transaction: Transaction,
	plan: SchemaPlan,
): { fts: boolean } {
	for (;;) {
		const state = schemaState(db, file, plan);
		if (state.status === "current") return { fts: state.fts };
		if (state.status === "empty") {
			const created = transaction(() =>
				schemaState(db, file, plan).status === "empty" ? createSchema(db, plan) : undefined,
			);
			if (created) return created;
			continue;
		}
		migrate(db, file, transaction, plan, backUp(db, file, state.version));
	}
}
