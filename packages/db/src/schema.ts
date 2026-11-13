import type { DatabaseSync } from "node:sqlite";
import { canMigrateFrom, readableFromFor, type SchemaPlan } from "./migrations.ts";
import * as schemaVersion from "./queries/schema-version.ts";
import { FTS, SCHEMA } from "./schema-sql.ts";

/** A foreign file or unsupported schema. Retrying the same file cannot fix it. */
export class AgentDbError extends Error {}

/** A distinct application ID keeps older, additive-schema writers out of workspace databases. */
export const AGENT_APPLICATION_ID = 0x4f634457;

/** The "OcPg" files of an earlier, incompatible Octocode store. */
const RETIRED_APPLICATION_ID = 0x4f635067;

/** Which of Octocode's database files a connection opens: its header id, its name in errors and its newest schema. */
export interface FileKind {
	applicationId: number;
	name: string;
	/** Creates the newest schema in an empty file; returns whether FTS5 was available. */
	create(db: DatabaseSync): { fts: boolean };
}

/** The coordination file (`workspaces.db`): its schema with the optional full-text index over memories. */
export const COORDINATION_FILE: FileKind = {
	applicationId: AGENT_APPLICATION_ID,
	name: "Octocode agent database",
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

/** What a file holds, read before any lock: usable as it is, empty and needing creation, or older and needing migration. */
type SchemaState = { status: "current"; fts: boolean } | { status: "empty" } | { status: "older"; version: number };

/** Reads the file's state, or throws `AgentDbError` when this Octocode cannot use it. Changes nothing. */
export function schemaState(db: DatabaseSync, file: string, plan: SchemaPlan, kind: FileKind): SchemaState {
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
		if (version === plan.version) return { status: "current", fts: Boolean(fts) };
		if (version > plan.version) {
			// The floor can only have risen since the read above, and a newer value is the one to obey.
			const needed = schemaVersion.readableFrom(db) ?? version;
			if (needed <= plan.version) return { status: "current", fts: Boolean(fts) };
			throw new AgentDbError(
				`${file} has unsupported Octocode schema version ${version}: it needs an Octocode that supports schema version ${needed} or newer, and this one stops at ${plan.version}. Nothing in the file changed. Update Octocode, or select another file with OCTOCODE_AGENT_DB.`,
			);
		}
		if (canMigrateFrom(plan, version)) return { status: "older", version };
		throw new AgentDbError(
			`${file} has unsupported Octocode schema version ${version}: this Octocode has no migration from it to ${plan.version}. Nothing in the file changed. Select another file with OCTOCODE_AGENT_DB.`,
		);
	}
	if (id === RETIRED_APPLICATION_ID)
		throw new AgentDbError(
			`${file} has unsupported Octocode schema version ${String(version)}; select a new file with OCTOCODE_AGENT_DB.`,
		);
	if (id !== 0 || version !== 0 || occupied)
		throw new AgentDbError(`${file} is not an ${kind.name}; set OCTOCODE_AGENT_DB to another file.`);
	return { status: "empty" };
}

/** Creates the newest schema in an empty file. The caller holds BEGIN IMMEDIATE and has rechecked that it is empty. */
export function createSchema(db: DatabaseSync, plan: SchemaPlan, kind: FileKind): { fts: boolean } {
	const { fts } = kind.create(db);
	// No row means the file's own version, so a file no older Octocode can read carries none.
	const floor = readableFromFor(plan, plan.version);
	if (floor < plan.version) schemaVersion.setReadableFrom(db, floor);
	db.exec(`PRAGMA application_id=${kind.applicationId}`);
	schemaVersion.set(db, plan.version);
	return { fts };
}
