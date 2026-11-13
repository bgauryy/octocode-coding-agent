import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, type AgentDb } from "../src/db.ts";
import { SCHEMA_PLAN } from "../src/migrations.ts";
import { TIMERS_SCHEMA_V4 } from "../src/schema-sql.ts";
import { loadSqlite } from "../src/sqlite.ts";
import * as timers from "../src/queries/timers.ts";
import { tmp } from "./helpers.ts";

const { DatabaseSync } = loadSqlite();

const open = (file: string): AgentDb =>
	openDatabase({
		file,
		mirrorFile: `${file}.transcripts`,
		archiveDir: path.join(path.dirname(file), "archive"),
		privateParent: false,
	});

/** A file as version 5 left it: the narrow `timers` table, with an active until timer, a done once timer and a gap in the ids. */
function versionFive(): string {
	const file = path.join(tmp(), "workspaces.db");
	const fresh = open(file);
	fresh.db.prepare("INSERT INTO workspaces (id, name, root, binding) VALUES ('w', 'w', '/w', 'path')").run();
	fresh.db.exec("DROP TABLE timers");
	fresh.db.exec(TIMERS_SCHEMA_V4);
	fresh.db
		.prepare(
			`INSERT INTO timers (id, workspace_id, session_id, note, kind, due_at, interval_ms, condition_kind, condition, cwd, deadline_at, created_at, updated_at)
			 VALUES (3, 'w', 's1', 'wait', 'until', 100, 15000, 'unlocked', 'src/a.ts', '/w', 999, 1, 1)`,
		)
		.run();
	fresh.db
		.prepare(
			`INSERT INTO timers (id, workspace_id, session_id, note, kind, due_at, status, stop_reason, ended_at, created_at, updated_at)
			 VALUES (7, 'w', 's1', 'once', 'once', 50, 'done', 'fired', 60, 1, 1)`,
		)
		.run();
	// A version 5 file has neither `backlog.rank` (step 7) nor the audit triggers that record it.
	for (const name of ["insert", "update", "delete"]) fresh.db.exec(`DROP TRIGGER backlog_audits_${name}`);
	fresh.db.exec("ALTER TABLE backlog DROP COLUMN rank");
	// Nor the `cache_write` columns of step 8.
	for (const table of ["agents", "agent_runs"]) fresh.db.exec(`ALTER TABLE ${table} DROP COLUMN cache_write`);
	fresh.db.exec("PRAGMA user_version = 5");
	fresh.close();
	return file;
}

describe("agent database migration 6: timers accept the new condition kinds", () => {
	it("is the newest step, and additive", () => {
		expect(SCHEMA_PLAN.migrations.find((step) => step.to === 6)).toMatchObject({ to: 6, additive: true });
	});

	it("rebuilds the table from version 5, keeping every row and id and adding the new columns", () => {
		const file = versionFive();
		const agent = open(file);
		try {
			const rows = agent.db.prepare("SELECT * FROM timers ORDER BY id").all() as unknown as timers.TimerRow[];
			expect(rows.map((row) => row.id)).toEqual([3, 7]);
			expect(rows[0]).toMatchObject({
				note: "wait",
				condition_kind: "unlocked",
				condition: "src/a.ts",
				cwd: "/w",
				deadline_at: 999,
				status: "active",
				baseline: null,
				checks: 0,
				spent_usd: 0,
			});
			expect(rows[1]).toMatchObject({ status: "done", stop_reason: "fired", ended_at: 60 });
			expect((agent.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
				SCHEMA_PLAN.version,
			);
			// The new kinds are accepted, an unknown one is still refused, and the timer queries work on the rebuilt table.
			const insert = (kind: string) =>
				timers.insert(agent.db, {
					workspaceId: "w",
					sessionId: "s1",
					note: "n",
					kind: "until",
					dueAt: 1,
					intervalMs: 5000,
					condition: { kind: kind as timers.TimerRow["condition_kind"] & string, value: "{}", baseline: "b" },
					at: 1,
				});
			for (const kind of ["file", "item", "agent", "port", "check"]) expect(insert(kind).condition_kind).toBe(kind);
			expect(() => insert("job")).toThrow(/CHECK/);
			const added = timers.insert(agent.db, {
				workspaceId: "w",
				sessionId: "s1",
				note: "x",
				kind: "once",
				dueAt: 1,
				at: 1,
			});
			expect(added.id).toBeGreaterThan(7);
			timers.recordResult(agent.db, 3, { exit: null, output: "o", spend: { calls: 2, usd: 0.01 } }, 5);
			expect(timers.sessionSpend(agent.db, "s1")).toBeCloseTo(0.01, 9);
			expect(timers.get(agent.db, 3)).toMatchObject({ checks: 2 });
			// Retention still reaches the rebuilt table and its indexes exist.
			expect(timers.purgeBefore(agent.db, 1000)).toBeGreaterThan(0);
			const indexes = agent.db
				.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'timers'")
				.all();
			expect(indexes.map((row) => (row as { name: string }).name)).toEqual(
				expect.arrayContaining(["timers_due", "timers_ended"]),
			);
		} finally {
			agent.close();
		}
	});

	it("leaves a backup at version 5 and a new file has the same table shape", () => {
		const file = versionFive();
		open(file).close();
		const backup = new DatabaseSync(`${file}.v5.bak`, { readOnly: true });
		try {
			expect((backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(5);
		} finally {
			backup.close();
		}
		const columns = (name: string) => {
			const db = new DatabaseSync(name, { readOnly: true });
			try {
				return (
					db.prepare("SELECT name FROM pragma_table_info('timers') ORDER BY cid").all() as { name: string }[]
				).map((c) => c.name);
			} finally {
				db.close();
			}
		};
		const created = path.join(tmp(), "workspaces.db");
		open(created).close();
		expect(columns(file)).toEqual(columns(created));
	});
});
