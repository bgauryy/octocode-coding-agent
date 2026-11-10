import type { DatabaseSync } from "node:sqlite";
import {
	AGENT_RUNS_SCHEMA_V3,
	BACKLOG_AUDIT_TRIGGERS,
	BACKLOG_AUDIT_TRIGGERS_V5,
	TIMERS_REBUILD_INDEXES,
	TIMERS_REBUILD_TABLE,
	TIMERS_SCHEMA_V4,
} from "./schema-sql.ts";

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
 * 3: the agent audit: `agent_runs`, one row per run of an agent (the parent writes its start and
 * outcome, whoever retires the agent row its end), and where an agent works (`agents.cwd`, `branch`, `process_title`).
 * A new table and nullable columns, so an Octocode that knows only version 2 keeps using the file (it never reads them).
 * The statements are the ones `schema-sql.ts` runs for a new file.
 */
const ADD_AGENT_RUNS: Migration = {
	to: 3,
	additive: true,
	up: (db) => {
		for (const column of ["cwd", "branch", "process_title"]) db.exec(`ALTER TABLE agents ADD COLUMN ${column} TEXT`);
		db.exec(AGENT_RUNS_SCHEMA_V3);
	},
};

/**
 * 4: `timers`, a session's own one-shot, repeating and wait-until wakes (`queries/timers.ts`). A new table, so an Octocode
 * that knows only version 3 keeps using the file (it never reads it).
 */
const ADD_TIMERS: Migration = {
	to: 4,
	additive: true,
	up: (db) => {
		db.exec(TIMERS_SCHEMA_V4);
	},
};

/**
 * 5: `backlog.closed`, the JSON of a closed item (kind, reason, optional duplicate target); an item with it is done
 * underneath and has no completion. The audit triggers are recreated to record it. A nullable column, so an Octocode that
 * knows only version 4 keeps using the file (it reads a closed item as done and never writes the column).
 */
const ADD_BACKLOG_CLOSED: Migration = {
	to: 5,
	additive: true,
	up: (db) => {
		db.exec("ALTER TABLE backlog ADD COLUMN closed TEXT");
		for (const name of ["backlog_audits_insert", "backlog_audits_update", "backlog_audits_delete"])
			db.exec(`DROP TRIGGER IF EXISTS ${name}`);
		db.exec(BACKLOG_AUDIT_TRIGGERS_V5);
	},
};

/** The columns `timers` had before step 6, copied as they are. */
const TIMERS_V4_COLUMNS = `id, workspace_id, session_id, agent, tool_call_id, note, kind, due_at, interval_ms, condition_kind,
	condition, cwd, max_runs, runs, deadline_at, status, stop_reason, last_fired_at, last_exit, last_output, created_at,
	updated_at, ended_at`;

/**
 * 6: `timers` accepts the condition kinds `file`, `item`, `agent`, `port` and `check`, and gains `baseline`, `checks` and
 * `spent_usd`. SQLite cannot widen a CHECK, so the table is rebuilt: a copy beside it, then renamed over it, every row and
 * id kept (the id sequence follows the copied maximum). Additive for an Octocode that knows only version 5: it inserts
 * with named columns, so the new ones take their defaults, and a row of a kind it does not know has no condition for it,
 * so it never fires that row.
 */
const WIDEN_TIMERS: Migration = {
	to: 6,
	additive: true,
	up: (db) => {
		db.exec(TIMERS_REBUILD_TABLE);
		db.exec(`INSERT INTO timers_next (${TIMERS_V4_COLUMNS}) SELECT ${TIMERS_V4_COLUMNS} FROM timers`);
		db.exec("DROP TABLE timers");
		db.exec("ALTER TABLE timers_next RENAME TO timers");
		db.exec(TIMERS_REBUILD_INDEXES);
	},
};

/**
 * 7: `backlog.rank`, a person's manual order of cards within a column (ascending, null until first ordered). The audit
 * triggers are recreated to record it. A nullable column, so an Octocode that knows only version 6 keeps using the file
 * (it never reads or writes the column, and the old triggers simply leave it out of the audit).
 */
const ADD_BACKLOG_RANK: Migration = {
	to: 7,
	additive: true,
	up: (db) => {
		db.exec("ALTER TABLE backlog ADD COLUMN rank REAL");
		for (const name of ["backlog_audits_insert", "backlog_audits_update", "backlog_audits_delete"])
			db.exec(`DROP TRIGGER IF EXISTS ${name}`);
		db.exec(BACKLOG_AUDIT_TRIGGERS);
	},
};

/**
 * 8: `agents.cache_write` and `agent_runs.cache_write`, the prompt tokens an agent wrote to cache (beside `cache_read`),
 * for the cache profiler. Defaulted columns, so an Octocode that knows only version 7 keeps using the file (it never reads
 * or writes them).
 */
const ADD_CACHE_WRITE: Migration = {
	to: 8,
	additive: true,
	up: (db) => {
		for (const table of ["agents", "agent_runs"])
			db.exec(`ALTER TABLE ${table} ADD COLUMN cache_write INTEGER NOT NULL DEFAULT 0`);
	},
};

export const SCHEMA_PLAN: SchemaPlan = {
	version: 8,
	migrations: [
		ADD_END_HINT,
		ADD_AGENT_RUNS,
		ADD_TIMERS,
		ADD_BACKLOG_CLOSED,
		WIDEN_TIMERS,
		ADD_BACKLOG_RANK,
		ADD_CACHE_WRITE,
	],
};

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
