import path from "node:path";
import { expect, it } from "vitest";
import * as agentRuns from "../src/queries/agent-runs.ts";
import { AGENT_RUN_ROUTE_COLUMN, SCHEMA } from "../src/schema-sql.ts";
import { loadSqlite } from "../src/sqlite.ts";
import { tmp } from "./helpers.ts";

const { DatabaseSync } = loadSqlite();

function fixture(legacy: boolean) {
	const db = new DatabaseSync(path.join(tmp("route-"), "workspaces.db"));
	db.exec(legacy ? SCHEMA.replace(`, ${AGENT_RUN_ROUTE_COLUMN}`, "") : SCHEMA);
	db.prepare(
		"INSERT INTO workspaces(id,name,root,binding) VALUES ('workspace','fixture','/owned-fixture','1:1')",
	).run();
	return db;
}
const hasRoute = (db: InstanceType<typeof DatabaseSync>) =>
	Boolean(db.prepare("SELECT 1 FROM pragma_table_info('agent_runs') WHERE name='route'").get());

it("stores the route a child run starts with", () => {
	const db = fixture(false);
	agentRuns.begin(db, { workspaceId: "workspace", agentId: "a", route: "subscription" });
	expect(agentRuns.latest(db, "a")?.route).toBe("subscription");
	db.close();
});

it("adds the column to a file created without it; its old rows read as unknown", () => {
	const db = fixture(true);
	expect(hasRoute(db)).toBe(false);
	db.prepare(
		"INSERT INTO agent_runs(run_id,workspace_id,agent_id,kind,started_at) VALUES ('old','workspace','old','child',1)",
	).run();
	expect(agentRuns.latest(db, "old")?.route).toBeUndefined();
	agentRuns.begin(db, { workspaceId: "workspace", agentId: "new", route: "config" });
	expect(hasRoute(db)).toBe(true);
	expect(agentRuns.latest(db, "new")?.route).toBe("config");
	expect(agentRuns.latest(db, "old")?.route).toBeUndefined();
	db.close();
});

it("refuses a route the contract does not name", () => {
	const db = fixture(false);
	expect(() =>
		db
			.prepare(
				"INSERT INTO agent_runs(run_id,workspace_id,agent_id,kind,started_at,route) VALUES ('x','workspace','x','child',1,'bogus')",
			)
			.run(),
	).toThrow();
	db.close();
});
