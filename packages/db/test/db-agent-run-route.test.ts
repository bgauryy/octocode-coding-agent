import path from "node:path";
import { expect, it } from "vitest";
import * as agentRuns from "../src/queries/agent-runs.ts";
import { SCHEMA } from "../src/schema-sql.ts";
import { loadSqlite } from "../src/sqlite.ts";
import { tmp } from "./helpers.ts";

const { DatabaseSync } = loadSqlite();

function fixture() {
	const db = new DatabaseSync(path.join(tmp("route-"), "workspaces.db"));
	db.exec(SCHEMA);
	db.prepare(
		"INSERT INTO workspaces(id,name,root,binding) VALUES ('workspace','fixture','/owned-fixture','1:1')",
	).run();
	return db;
}
it("stores the route a child run starts with", () => {
	const db = fixture();
	agentRuns.begin(db, { workspaceId: "workspace", agentId: "a", route: "subscription" });
	expect(agentRuns.latest(db, "a")?.route).toBe("subscription");
	db.close();
});

it("refuses a route the contract does not name", () => {
	const db = fixture();
	expect(() =>
		db
			.prepare(
				"INSERT INTO agent_runs(run_id,workspace_id,agent_id,kind,started_at,route) VALUES ('x','workspace','x','child',1,'bogus')",
			)
			.run(),
	).toThrow();
	db.close();
});
