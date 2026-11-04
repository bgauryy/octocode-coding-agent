import type { DatabaseSync } from "node:sqlite";

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

export const SCHEMA_PLAN: SchemaPlan = { version: FIRST_SCHEMA_VERSION, migrations: [] };

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
