import type { DatabaseSync } from "node:sqlite";
import * as schemaVersion from "./queries/schema-version.ts";
import { ENSURED_OBJECTS, FTS, SCHEMA } from "./schema-sql.ts";
import { ensureAddedColumns } from "./schema-columns.ts";

/** A foreign file or unsupported schema. Retrying the same file cannot fix it. */
export class AgentDbError extends Error {}

/** The `PRAGMA application_id` of a coordination file ("OcDW"): no other SQLite file carries it. */
export const AGENT_APPLICATION_ID = 0x4f634457;

/** Which of Octocode's database files a connection opens: its header id, its name in errors and its schema. */
export interface FileKind {
	applicationId: number;
	name: string;
	/** The one schema version this Octocode writes and reads; a file at any other version is refused. */
	version: number;
	/** Adds objects an existing current file may lack; runs on every open. */
	ensure?(db: DatabaseSync): void;
	/** Creates the newest schema in an empty file; returns whether FTS5 was available. */
	create(db: DatabaseSync): { fts: boolean };
}

/** The coordination file (`workspaces.db`): its schema with the optional full-text index over memories. */
export const COORDINATION_FILE: FileKind = {
	applicationId: AGENT_APPLICATION_ID,
	name: "Octocode agent database",
	version: 10,
	ensure: (db) => {
		db.exec(ENSURED_OBJECTS);
		ensureAddedColumns(db);
	},
	create: (db) => {
		db.exec(SCHEMA);
		try {
			db.exec(FTS);
			return { fts: true };
		} catch (error) {
			if (!(error instanceof Error && /no such module: fts5/i.test(error.message))) throw error;
			return { fts: false };
		}
	},
};

type Transaction = <T>(fn: () => T) => T;

/** What a file holds, read before any lock: usable as it is, or empty and needing creation. */
type SchemaState = { status: "current"; fts: boolean } | { status: "empty" };

/** Reads the file's state, or throws `AgentDbError` when this Octocode cannot use it. Changes nothing. */
function schemaState(db: DatabaseSync, file: string, kind: FileKind): SchemaState {
	// The first opener can commit between two separate PRAGMAs. Read both header fields and catalog facts in one snapshot.
	const {
		application_id: id,
		user_version: version,
		occupied,
		fts,
	} = db
		.prepare(`
		SELECT application_id, user_version, EXISTS(SELECT 1 FROM sqlite_schema) AS occupied,
			EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memories_fts') AS fts
		FROM pragma_application_id, pragma_user_version`)
		.get()!;
	if (id === kind.applicationId && typeof version === "number") {
		if (version === kind.version) return { status: "current", fts: Boolean(fts) };
		if (version > kind.version)
			throw new AgentDbError(
				`${file} has Octocode schema version ${version}, newer than this Octocode's ${kind.version}. Nothing in the file changed. Update Octocode, or select another file with OCTOCODE_AGENT_DB.`,
			);
		throw new AgentDbError(
			`${file} has Octocode schema version ${version}, older than this Octocode's ${kind.version}. Nothing in the file changed. Delete it, or select another file with OCTOCODE_AGENT_DB.`,
		);
	}
	if (id !== 0 || version !== 0 || occupied)
		throw new AgentDbError(`${file} is not an ${kind.name}; set OCTOCODE_AGENT_DB to another file.`);
	return { status: "empty" };
}

/**
 * Brings the open database to its schema and returns its FTS capability: nothing for a current file, creation for an
 * empty one. A file that cannot be used throws `AgentDbError` before anything in it changes. An empty file is checked
 * again under the write lock, since another process may have created the schema meanwhile.
 */
export function prepareSchema(
	db: DatabaseSync,
	file: string,
	transaction: Transaction,
	kind: FileKind,
): { fts: boolean } {
	for (;;) {
		const state = schemaState(db, file, kind);
		if (state.status === "current") {
			kind.ensure?.(db);
			return { fts: state.fts };
		}
		const created = transaction(() => {
			if (schemaState(db, file, kind).status !== "empty") return undefined;
			const made = kind.create(db);
			db.exec(`PRAGMA application_id=${kind.applicationId}`);
			schemaVersion.set(db, kind.version);
			return made;
		});
		if (created) return created;
	}
}
