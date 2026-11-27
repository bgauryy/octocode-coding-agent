import type { DatabaseSync } from "node:sqlite";
import * as schemaVersion from "./queries/schema-version.ts";
import { FTS, SCHEMA } from "./schema-sql.ts";
import {
	backupBeforeUpgrade,
	COORDINATION_MIGRATIONS,
	type Migration,
	migrationChain,
	minReaderAfter,
	newestBackup,
} from "./schema-migrations.ts";

/** A foreign file or unsupported schema. Retrying the same file cannot fix it. */
export class AgentDbError extends Error {}

/** The `PRAGMA application_id` of a coordination file ("OcDW"): no other SQLite file carries it. */
export const AGENT_APPLICATION_ID = 0x4f634457;

/** Which of Octocode's database files a connection opens: its header id, its name in errors and its schema. */
export interface FileKind {
	applicationId: number;
	name: string;
	/** The schema version this Octocode writes and reads; an older file is upgraded through `migrations`, a newer one refused. */
	version: number;
	/**
	 * The oldest schema version that can still read a file this Octocode creates: `version` when the schema has breaking
	 * changes since, else the version before the first change that only added things. A newer file stamped with a
	 * `min_reader` at or below this build's `version` opens as it is.
	 */
	minReader: number;
	/** Upgrade steps, one per from-version; a file older than the first step's `from` is refused. */
	migrations?: readonly Migration[];
	/**
	 * The step to `version` when it is no migration but runs only for openers that take it (the machine file's split,
	 * `schema-split.ts`). New files and migrations stop at `from`, which every opener reads as it is; an opener that does
	 * not take the step refuses a file at `version` with `refusal(file)`.
	 */
	optionalStep?: { from: number; refusal(file: string): string };
	/** Creates the newest schema in an empty file; returns whether FTS5 was available. */
	create(db: DatabaseSync): { fts: boolean };
}

/** The `PRAGMA application_id` of a workspace file ("OcWS"). */
const WORKSPACE_APPLICATION_ID = 0x4f635753;

/** The shared DDL with the optional full-text index over memories; returns whether FTS5 was available. */
function createSchema(db: DatabaseSync): { fts: boolean } {
	db.exec(SCHEMA);
	try {
		db.exec(FTS);
		return { fts: true };
	} catch (error) {
		if (!(error instanceof Error && /no such module: fts5/i.test(error.message))) throw error;
		return { fts: false };
	}
}

/**
 * The machine file (`workspaces.db`, the coordination file): the workspace registry and machine-wide rows (sessions,
 * memories, trust, providers, samples, shell history, config audits). New and upgraded files are at version 12, which
 * version 10 still reads. Version 13 is a split file: its workspace rows live in workspace files, and only the split
 * (`schema-split.ts`) writes it, with `min_reader` 13, so no build that keeps workspace rows in it can open it.
 */
export const COORDINATION_FILE: FileKind = {
	applicationId: AGENT_APPLICATION_ID,
	name: "Octocode agent database",
	version: 13,
	minReader: 10,
	migrations: COORDINATION_MIGRATIONS,
	optionalStep: {
		from: 12,
		refusal: (file) =>
			`${file} was split into workspace files (schema 13): its backlog, team, timer and event rows moved to the workspaces folder beside it. This Octocode keeps those rows in the machine file, so it must not open it, and nothing in the file changed. Run an Octocode with workspace files on, or roll the split back as the configuration guide describes.`,
	},
	create: createSchema,
};

/**
 * A workspace file (`workspaces/<key>.db`): the rows of the workspaces of one repository (`schema-split.ts`
 * `WORKSPACE_TABLES`) and the registry rows they name. It shares the machine file's DDL, so every query runs on either;
 * a change to that DDL is a step in both kinds' migrations.
 */
export const WORKSPACE_FILE: FileKind = {
	applicationId: WORKSPACE_APPLICATION_ID,
	name: "Octocode workspace database",
	version: 1,
	minReader: 1,
	create: createSchema,
};

type Transaction = <T>(fn: () => T) => T;

/** What a file holds, read before any lock: usable as it is, at an older version with steps to upgrade it, or empty. */
type SchemaState =
	| { status: "current"; fts: boolean; stamped: boolean }
	| { status: "older"; version: number; steps: Migration[] }
	| { status: "empty" };

/**
 * Reads the file's state, or throws `AgentDbError` when this opener cannot use it. Changes nothing. `takesStep`: the
 * opener takes `kind.optionalStep`, so it reads a file at `kind.version` too.
 */
function schemaState(db: DatabaseSync, file: string, kind: FileKind, takesStep: boolean): SchemaState {
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
		const base = baseVersion(kind);
		const newest = takesStep ? kind.version : base;
		if (version >= base && version <= newest)
			return { status: "current", fts: Boolean(fts), stamped: schemaVersion.minReader(db) !== undefined };
		if (kind.optionalStep && version > newest && version <= kind.version)
			throw new AgentDbError(kind.optionalStep.refusal(file));
		if (version > newest) {
			// A newer file that only added things (stamped min_reader <= this version) is read as it is, never rewritten.
			const oldest = schemaVersion.minReader(db);
			if (oldest !== undefined && oldest <= newest) return { status: "current", fts: Boolean(fts), stamped: true };
			const backup = newestBackup(file, version);
			throw new AgentDbError(
				`${file} has Octocode schema version ${version}, newer than this Octocode's ${newest}${oldest === undefined ? "" : `; only schema ${oldest} or newer can read it`}. Nothing in the file changed. Update Octocode, or use a separate file with OCTOCODE_HOME or OCTOCODE_AGENT_DB.${backup ? ` The copy taken before its upgrade is ${backup}.` : ""}`,
			);
		}
		const steps = migrationChain(kind.migrations ?? [], version, base);
		if (steps) return { status: "older", version, steps };
		throw new AgentDbError(
			`${file} has Octocode schema version ${version}, older than this Octocode's ${base}, which cannot upgrade it. Nothing in the file changed. Delete it, or select another file with OCTOCODE_AGENT_DB.`,
		);
	}
	if (id !== 0 || version !== 0 || occupied)
		throw new AgentDbError(`${file} is not an ${kind.name}; set OCTOCODE_AGENT_DB to another file.`);
	return { status: "empty" };
}

/** The version new files and migrations reach: the one before `kind.optionalStep`, else `kind.version`. */
export const baseVersion = (kind: FileKind): number => kind.optionalStep?.from ?? kind.version;

/**
 * Brings the open database to its schema and returns its FTS capability: nothing for a current file, creation for an
 * empty one, and for an older file a backup beside it (`backupPath`) followed by its upgrade steps and the new version
 * in one write transaction. New and upgraded files stop before `kind.optionalStep`, which only its owner writes; an
 * opener that does not take it (`takesStep`) refuses a file it wrote. A file that cannot be used throws `AgentDbError`
 * before anything in it changes. An empty or older file is checked again under the write lock, since another process
 * may have created or upgraded it meanwhile.
 */
export function prepareSchema(
	db: DatabaseSync,
	file: string,
	transaction: Transaction,
	kind: FileKind,
	takesStep = false,
): { fts: boolean } {
	for (;;) {
		const state = schemaState(db, file, kind, takesStep);
		if (state.status === "current") {
			if (state.stamped) return { fts: state.fts };
			// A current file written before stamps existed gets the stamp once, additively.
			transaction(() => {
				if (schemaVersion.minReader(db) === undefined) schemaVersion.setMinReader(db, kind.minReader);
			});
			continue;
		}
		if (state.status === "older") {
			backupBeforeUpgrade(db, file, state.version);
			transaction(() => {
				const locked = schemaState(db, file, kind, takesStep);
				if (locked.status !== "older") return;
				const stored = schemaVersion.minReader(db) ?? locked.version;
				for (const step of locked.steps) step.run(db);
				schemaVersion.setMinReader(db, minReaderAfter(stored, locked.steps));
				schemaVersion.set(db, baseVersion(kind));
			});
			continue;
		}
		const created = transaction(() => {
			if (schemaState(db, file, kind, takesStep).status !== "empty") return undefined;
			const made = kind.create(db);
			db.exec(`PRAGMA application_id=${kind.applicationId}`);
			schemaVersion.setMinReader(db, kind.minReader);
			schemaVersion.set(db, baseVersion(kind));
			return made;
		});
		if (created) return created;
	}
}
