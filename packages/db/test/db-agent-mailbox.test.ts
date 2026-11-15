import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import * as agents from "../src/queries/agents.ts";
import * as events from "../src/queries/agent-events.ts";
import { AGENT_MAILBOX_COLUMN, SCHEMA } from "../src/schema-sql.ts";
import { AGENT_APPLICATION_ID, COORDINATION_FILE } from "../src/schema.ts";
import { loadSqlite } from "../src/sqlite.ts";
import { tmp } from "./helpers.ts";

const { DatabaseSync } = loadSqlite();
function legacy() {
	const file = path.join(tmp("mailbox-schema10-"), "workspaces.db");
	const db = new DatabaseSync(file);
	db.exec(SCHEMA.replace(`, ${AGENT_MAILBOX_COLUMN}`, ""));
	db.exec(`PRAGMA application_id=${AGENT_APPLICATION_ID}; PRAGMA user_version=${COORDINATION_FILE.version}`);
	db.prepare(
		"INSERT INTO workspaces(id,name,root,binding) VALUES ('workspace','fixture','/owned-fixture','1:1')",
	).run();
	db.prepare(
		"INSERT INTO agents(id,team,workspace_id,role,pid,status,joined_at,seen_at) VALUES ('legacy','team','workspace','general',1,'idle',1,1)",
	).run();
	db.prepare(
		"INSERT INTO messages(team,workspace_id,sender,body,created_at) VALUES ('team','workspace','legacy','PRESERVE_MESSAGE',1)",
	).run();
	return { file, db };
}
const member = (id: string): Member => ({
	id,
	role: "runner fixture",
	parentId: "legacy",
	pid: process.pid,
	status: "working",
	mailbox: "pull",
	joinedAt: 2,
	updatedAt: 2,
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
});
const hasColumn = (db: InstanceType<typeof DatabaseSync>) =>
	Boolean(db.prepare("SELECT 1 FROM pragma_table_info('agents') WHERE name='mailbox'").get());

it("lists a read-only schema10 file before first write and preserves its rows during additive admission", () => {
	const { file, db } = legacy();
	db.close();
	const before = fs.readFileSync(file);
	const read = new DatabaseSync(file, { readOnly: true });
	try {
		expect(agents.inTeam(read, "team")[0]).not.toHaveProperty("mailbox");
		expect(hasColumn(read)).toBe(false);
	} finally {
		read.close();
	}
	const write = new DatabaseSync(file);
	try {
		expect(fs.readFileSync(file)).toEqual(before);
		expect(
			agents.insert(write, "team", { id: "workspace" }, member("external"), {
				activationId: "activation",
				sessionId: "session",
			}),
		).toBe(true);
		expect(agents.inTeam(write, "team").map((row) => [row.id, row.mailbox])).toEqual([
			["legacy", null],
			["external", "pull"],
		]);
		expect(write.prepare("SELECT body FROM messages").get()).toMatchObject({ body: "PRESERVE_MESSAGE" });
		expect(write.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 10 });
		expect(events.list(write, "workspace").find((event) => event.type === "create")?.data.mailbox).toBe("pull");
		expect(agents.refresh(write, { ...member("external"), mailbox: undefined }, { id: "workspace" })).toBe(true);
		expect(agents.inTeam(write, "team")[1].mailbox).toBeNull();
	} finally {
		write.close();
	}
});

it("does not cache an additive change rolled back by the caller", () => {
	const { db } = legacy();
	try {
		db.exec("BEGIN IMMEDIATE");
		agents.ensureMailbox(db);
		expect(hasColumn(db)).toBe(true);
		db.exec("ROLLBACK");
		expect(hasColumn(db)).toBe(false);
		agents.ensureMailbox(db);
		expect(hasColumn(db)).toBe(true);
		expect(agents.insert(db, "team", { id: "workspace" }, member("retried"))).toBe(true);
		expect(agents.ids(db)).toEqual(expect.arrayContaining(["legacy", "retried"]));
	} finally {
		db.close();
	}
});

it("serializes concurrent first-use admission from two real Node processes", async () => {
	const { file, db } = legacy();
	db.close();
	const ensureUrl = new URL("../src/queries/agent-mailbox.ts", import.meta.url).href;
	const sqliteUrl = new URL("../src/sqlite.ts", import.meta.url).href;
	const source = `import {loadSqlite} from ${JSON.stringify(sqliteUrl)};import{ensureMailbox}from ${JSON.stringify(ensureUrl)};const{DatabaseSync}=loadSqlite();const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=5000');ensureMailbox(db);db.close();`;
	const run = () =>
		new Promise<void>((resolve, reject) => {
			const child = spawn(process.execPath, ["--input-type=module", "-e", source, file], {
				cwd: path.dirname(fileURLToPath(import.meta.url)),
				stdio: ["ignore", "pipe", "pipe"],
			});
			let error = "";
			child.stderr.on("data", (chunk) => {
				error += chunk;
			});
			child.once("error", reject);
			child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(error))));
		});
	await Promise.all([run(), run()]);
	const read = new DatabaseSync(file, { readOnly: true });
	try {
		expect(hasColumn(read)).toBe(true);
		expect(agents.ids(read)).toEqual(["legacy"]);
	} finally {
		read.close();
	}
});
