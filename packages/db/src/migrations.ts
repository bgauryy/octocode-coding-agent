import type { DatabaseSync } from "node:sqlite";
import { AGENT_RUNS_SCHEMA } from "./schema-sql.ts";

/**
 * One step of the agent database's schema history. To change the schema: edit `schema-sql.ts` (a new file starts at the
 * newest version), raise `SCHEMA_PLAN.version` and add the step here, so existing files reach the same shape.
 */
export interface Migration {
	/** The version this step produces, from `to - 1`. */
	to: number;
	/**
	 * Whether an Octocode that knows only earlier versions can keep using the file: new tables, indexes, and nullable or
	 * defaulted columns. A step that renames, drops or changes the meaning of anything is not additive, and such an Octocode
	 * refuses the file and names the version it needs.
	 */
	additive: boolean;
	/** Runs inside the step's `BEGIN IMMEDIATE` transaction; a throw rolls the step back. */
	up(db: DatabaseSync): void;
}

export interface SchemaPlan {
	/** The newest version this Octocode writes. */
	version: number;
	migrations: readonly Migration[];
}

/** No earlier version exists: a file at 0 predates versioning and has no path forward. */
export const FIRST_SCHEMA_VERSION = 1;

/**
 * 2: `agents.end_hint`, why the parent is ending a child (`stopped-user`, `stopped-parent`, `failed`), written before the
 * child dies so the one that retires the row can name the cause. A nullable column, so an Octocode that knows only
 * version 1 keeps using the file (it never reads or writes it).
 */
const ADD_END_HINT: Migration = {
	to: 2,
	additive: true,
	up: (db) => {
		db.exec("ALTER TABLE agents ADD COLUMN end_hint TEXT");
	},
};

/**
 * 3: the agent audit (design B36 §4-§5): `agent_runs`, one row per run of an agent (the parent writes its start and
 * outcome, whoever retires the agent row its end), and where an agent works (`agents.cwd`, `branch`, `process_title`).
 * A new table and nullable columns, so an Octocode that knows only version 2 keeps using the file (it never reads them).
 * The statements are the ones `schema-sql.ts` runs for a new file.
 */
const ADD_AGENT_RUNS: Migration = {
	to: 3,
	additive: true,
	up: (db) => {
		for (const column of ["cwd", "branch", "process_title"]) db.exec(`ALTER TABLE agents ADD COLUMN ${column} TEXT`);
		db.exec(AGENT_RUNS_SCHEMA);
	},
};

export const SCHEMA_PLAN: SchemaPlan = { version: 3, migrations: [ADD_END_HINT, ADD_AGENT_RUNS] };

/** The oldest version that can use a file at `version`: the last step up to it that was not additive, else the first version. */
export function readableFromFor(plan: SchemaPlan, version: number): number {
	let floor = FIRST_SCHEMA_VERSION;
	for (const step of plan.migrations) if (step.to <= version && !step.additive) floor = Math.max(floor, step.to);
	return floor;
}

/** Whether `plan` has every step from `version` up to its newest. */
export function canMigrateFrom(plan: SchemaPlan, version: number): boolean {
	if (version < FIRST_SCHEMA_VERSION) return false;
	for (let to = version + 1; to <= plan.version; to++)
		if (!plan.migrations.some((step) => step.to === to)) return false;
	return true;
}
