import path from "node:path";
import { expect, it } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import * as agents from "../src/queries/agents.ts";
import {
	AGENT_MAILBOX_COLUMN,
	AGENT_STATUS_CHECK,
	AGENT_STATUS_CHECK_WITHOUT_SETTLED,
	SCHEMA,
} from "../src/schema-sql.ts";
import { AGENT_APPLICATION_ID, COORDINATION_FILE } from "../src/schema.ts";
import { loadSqlite } from "../src/sqlite.ts";
import { tmp } from "./helpers.ts";

const { DatabaseSync } = loadSqlite();

/** A schema10 file as written before the `settled` status and the mailbox column existed. */
function before() {
	const db = new DatabaseSync(path.join(tmp("settled-schema10-"), "workspaces.db"));
	db.exec(
		SCHEMA.replace(AGENT_STATUS_CHECK, AGENT_STATUS_CHECK_WITHOUT_SETTLED).replace(`, ${AGENT_MAILBOX_COLUMN}`, ""),
	);
	db.exec(`PRAGMA application_id=${AGENT_APPLICATION_ID}; PRAGMA user_version=${COORDINATION_FILE.version}`);
	db.prepare(
		"INSERT INTO workspaces(id,name,root,binding) VALUES ('workspace','fixture','/owned-fixture','1:1')",
	).run();
	db.prepare(
		"INSERT INTO agents(id,team,workspace_id,role,pid,status,joined_at,seen_at,task) VALUES ('legacy','team','workspace','general',1,'working',1,1,'KEEP')",
	).run();
	return db;
}

const member = (id: string, status: Member["status"]): Member => ({
	id,
	role: "general",
	pid: 2,
	status,
	joinedAt: 2,
	updatedAt: 2,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
});

it("refuses settled in a file written before the status existed, until a writer widens the check", () => {
	const db = before();
	try {
		expect(() => db.prepare("UPDATE agents SET status = 'settled'").run()).toThrow(/CHECK/);
		expect(agents.insert(db, "team", { id: "workspace" }, member("child", "working"))).toBe(true);
		const settled = () => agents.inTeam(db, "team").map((row) => [row.id, row.status]);
		expect(agents.settle(db, "child", { pid: 2 }, { pid: 3 }, "completed")).toBe(true);
		expect(settled()).toEqual([
			["legacy", "working"],
			["child", "settled"],
		]);
		expect(agents.processOf(db, "child")).toEqual({ pid: 3 });
		// Rows, columns and indexes of the rebuilt table are the old ones.
		expect(agents.inTeam(db, "team")[0]).toMatchObject({ task: "KEEP", pid: 1 });
		const indexes = db
			.prepare(
				"SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='agents' AND sql IS NOT NULL ORDER BY name",
			)
			.all();
		expect(indexes.map((row) => row.name)).toEqual(["agents_scope", "agents_workspace"]);
		// A settled row is not revived by its old process, and not counted among the processes that read mail.
		expect(agents.refresh(db, member("child", "working"), { id: "workspace" })).toBe(false);
		expect(agents.processes(db, "team").map((row) => row.id)).toEqual(["legacy"]);
		expect(db.prepare("SELECT end_hint FROM agents WHERE id = 'child'").get()).toEqual({ end_hint: "completed" });
		expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: COORDINATION_FILE.version });
	} finally {
		db.close();
	}
});

it("leaves a current file untouched", () => {
	const db = new DatabaseSync(":memory:");
	db.exec(SCHEMA);
	const sql = () => db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'agents'").get();
	const was = sql();
	agents.ensureSettledStatus(db);
	expect(sql()).toEqual(was);
	db.close();
});
