import type { DatabaseSync } from "node:sqlite";
import { FTS, SCHEMA } from "./schema-sql.ts";

/** A foreign file or unsupported schema. Retrying the same file cannot fix it. */
export class AgentDbError extends Error {}

/** A distinct application ID keeps older, additive-schema writers out of workspace databases. */
export const AGENT_APPLICATION_ID = 0x4f634457;
const SCHEMA_VERSION = 1;

/** Returns the FTS capability for a current file, or undefined if initialization is needed. */
export function schemaState(db: DatabaseSync, file: string): { fts: boolean } | undefined {
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
	if (id === AGENT_APPLICATION_ID && version === SCHEMA_VERSION) return { fts: Boolean(fts) };
	if (id === AGENT_APPLICATION_ID || id === 0x4f635067)
		throw new AgentDbError(
			`${file} has unsupported Octocode schema version ${String(version)}; select a new file with OCTOCODE_AGENT_DB.`,
		);
	if (id !== 0 || version !== 0 || occupied)
		throw new AgentDbError(`${file} is not an Octocode agent database; set OCTOCODE_AGENT_DB to another file.`);
	return undefined;
}

/** Caller holds BEGIN IMMEDIATE. Recheck ownership and version in case another process just initialized the file. */
export function ensureSchema(db: DatabaseSync, file: string): { fts: boolean } {
	const current = schemaState(db, file);
	if (current) return current;
	db.exec(SCHEMA);
	let fts = true;
	try {
		db.exec(FTS);
	} catch (error) {
		if (!(error instanceof Error && /no such module: fts5/i.test(error.message))) throw error;
		fts = false;
	}
	db.exec(`PRAGMA application_id=${AGENT_APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}`);
	return { fts };
}
