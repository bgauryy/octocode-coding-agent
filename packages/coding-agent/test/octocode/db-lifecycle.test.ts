import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AgentDb,
	DEFAULT_HISTORY_WINDOWS,
	archiveHistory,
	expire,
	maintenance,
	purge,
	sessions,
	transcripts,
	workspaces,
} from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { DAY_MS } from "../../src/octocode/shared/util.ts";
import { tmp } from "./helpers.ts";

let agent: AgentDb;
let file: string;
beforeEach(() => {
	file = path.join(tmp(), "lifecycle.db");
	agent = openAgentDb(file);
});
afterEach(() => agent.close());

const count = (table: string, where = "1") =>
	(agent.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
const workspace = (id: string) => {
	workspaces.register(agent.db, { id, root: `/r/${id}`, name: id, binding: `1:${id.length}` });
	return id;
};
const stamp = { size: 1, mtime: "1000000000", binding: "1:2" };
/** A session with a transcript of two entries, a compaction, an event, a session task and a command receipt. */
function seedSession(id: string, ws: string, mtimeNs = stamp.mtime) {
	transcripts.bind(agent.db, id, ws);
	transcripts.save(
		agent.db,
		id,
		`/t/${id}.jsonl`,
		{ id },
		{ ...stamp, mtime: mtimeNs },
		[
			{ id: "e1", parentId: null, type: "message" },
			{ id: "e2", parentId: "e1", type: "message" },
		],
		0,
	);
	agent.db
		.prepare("INSERT INTO compaction_summaries(workspace_id,session_id,entry_id,summary) VALUES (?,?,?,?)")
		.run(ws, id, "c1", "s");
	agent.db
		.prepare(
			"INSERT INTO agent_events(id,workspace_id,time,session_id,type,data,version) VALUES (?,?,?,?,'init','{}',1)",
		)
		.run(`ev-${id}`, ws, new Date(5000).toISOString(), id);
	agent.db
		.prepare("INSERT INTO backlog_tasks(workspace_id,seq,session_id,goal,created_at,updated_at) VALUES (?,?,?,?,1,1)")
		.run(ws, count("backlog_tasks", `workspace_id='${ws}'`) + 1, id, "g");
	agent.db
		.prepare(
			"INSERT INTO workspace_commands(id,session_id,workspace_id,action,input,status,at,message) VALUES ('c',?,?,'a','i','ok',1,'m')",
		)
		.run(id, ws);
}
const SESSION_TABLES = [
	"sessions",
	"session_transcripts",
	"session_entries",
	"compaction_summaries",
	"agent_events",
	"backlog_tasks",
	"workspace_commands",
];

describe("session liveness row", () => {
	it("repairs a row created without a pid when the process saves stats, keeping a known start time", () => {
		const ws = workspace("w");
		transcripts.bind(agent.db, "s", ws);
		expect(sessions.pidOf(agent.db, "s")).toEqual({ pid: null, pid_started: null });
		const stats = { cost: 1, tokens: 2, filesChanged: 0, unpriced: false, branch: null, head: null };
		sessions.saveStats(agent.db, "s", { ...stats, pid: 10, pidStarted: "t10" });
		expect(sessions.pidOf(agent.db, "s")).toEqual({ pid: 10, pid_started: "t10" });
		// `ps` failing later in the same process must not erase what was recorded.
		sessions.saveStats(agent.db, "s", { ...stats, pid: 10, pidStarted: null });
		expect(sessions.pidOf(agent.db, "s")).toEqual({ pid: 10, pid_started: "t10" });
		// Another process took the session over: its pid and its (possibly unknown) start time replace both.
		sessions.saveStats(agent.db, "s", { ...stats, pid: 11, pidStarted: null });
		expect(sessions.pidOf(agent.db, "s")).toEqual({ pid: 11, pid_started: null });
	});
});

describe("forget and erase", () => {
	it("forget drops the extras and keeps the transcript mirror, so an ID-based fork can still recover it", () => {
		const ws = workspace("w");
		seedSession("a", ws);
		agent.db.prepare("UPDATE sessions SET cost = 3, branch = 'main', pid = 7 WHERE id = 'a'").run();
		sessions.forget(agent.db, "a");
		expect(sessions.byId(agent.db, "a")).toMatchObject({ cost: 0, branch: null, pid: null });
		expect(SESSION_TABLES.map((table) => count(table))).toEqual([1, 1, 2, 1, 1, 1, 1]);
		expect(transcripts.records(agent.db, "a")).toHaveLength(3);
		// With nothing durable behind it, the row itself goes.
		transcripts.bind(agent.db, "bare", ws);
		sessions.forget(agent.db, "bare");
		expect(sessions.byId(agent.db, "bare")).toBeUndefined();
	});

	it("erase removes every per-session row of the sessions and nothing else", () => {
		const ws = workspace("w");
		seedSession("a", ws);
		seedSession("b", ws);
		seedSession("keep", ws);
		agent.db.prepare("INSERT INTO session_forks(child_id,parent_id,child_file) VALUES ('b','a','/t/b.jsonl')").run();
		const counts = sessions.erase(agent.db, ["a", "b", "missing"]);
		expect(counts).toEqual({
			sessions: 2,
			transcripts: 2,
			entries: 4,
			forks: 1,
			compactions: 2,
			events: 2,
			tasks: 2,
			commands: 2,
			timers: 0,
		});
		for (const table of SESSION_TABLES)
			expect(
				count(table, "session_id IN ('a','b')".replace("session_id", table === "sessions" ? "id" : "session_id")),
			).toBe(0);
		expect(count("sessions")).toBe(1);
		expect(count("session_entries")).toBe(2);
		expect(sessions.erase(agent.db, ["keep"]).sessions).toBe(1);
		expect(SESSION_TABLES.map((table) => count(table))).toEqual(SESSION_TABLES.map(() => 0));
		expect(sessions.erase(agent.db, [])).toMatchObject({ sessions: 0 });
	});

	it("is atomic: a failure part way leaves every row", () => {
		const ws = workspace("w");
		seedSession("a", ws);
		agent.db.exec("CREATE TRIGGER stop BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'stop'); END");
		expect(() => sessions.erase(agent.db, ["a"])).toThrow(/stop/);
		expect(SESSION_TABLES.map((table) => count(table))).toEqual([1, 1, 2, 1, 1, 1, 1]);
	});
});

describe("purge", () => {
	function seedBacklog(ws: string) {
		agent.db
			.prepare(
				"INSERT INTO backlog(workspace_id,seq,title,state,created_by,created_at,updated_at) VALUES (?,1,'t','todo','u',1,1)",
			)
			.run(ws);
		const item = (agent.db.prepare("SELECT id FROM backlog WHERE workspace_id=?").get(ws) as { id: number }).id;
		agent.db.prepare("INSERT INTO backlog_notes(item,at,author,kind,text) VALUES (?,1,'u','note','n')").run(item);
		agent.db.prepare("INSERT INTO backlog_links(item,relation,target) VALUES (?,'r','x')").run(item);
		agent.db.prepare("INSERT INTO backlog_completions(item,operation_key,payload) VALUES (?,'k','{}')").run(item);
		agent.db
			.prepare(
				"INSERT INTO leases(workspace_id,path,path_key,kind,owner,reason,acquired_at,expires_at) VALUES (?,'p','p','file','o','r',1,2)",
			)
			.run(ws);
		agent.db.prepare("INSERT INTO edits(workspace_id,path,agent,tool,at) VALUES (?,'p','a','t',1)").run(ws);
		agent.db.prepare("INSERT INTO messages(team,workspace_id,sender,body,created_at) VALUES ('t',?,'s','b',1)").run(ws);
		agent.db
			.prepare("INSERT INTO deliveries(message,recipient) SELECT id,'r' FROM messages WHERE workspace_id=?")
			.run(ws);
		agent.db
			.prepare(
				"INSERT INTO agents(id,team,workspace_id,role,pid,status,joined_at,seen_at) VALUES (?,'t',?,'main',1,'idle',1,1)",
			)
			.run(`agent-${ws}`, ws);
		agent.db
			.prepare(
				"INSERT INTO memories(scope,workspace_id,title,author,created_at,updated_at) VALUES ('workspace',?,'m','u',1,1)",
			)
			.run(ws);
		agent.db.prepare("INSERT INTO meta(key,value) VALUES (?,'3')").run(`backlog_seq:${ws}`);
	}
	const owned = (ws: string) =>
		[
			["sessions", "workspace_id"],
			["backlog", "workspace_id"],
			["backlog_audits", "workspace_id"],
			["backlog_tasks", "workspace_id"],
			["workspace_commands", "workspace_id"],
			["agent_events", "workspace_id"],
			["compaction_summaries", "workspace_id"],
			["messages", "workspace_id"],
			["leases", "workspace_id"],
			["edits", "workspace_id"],
			["agents", "workspace_id"],
			["memories", "workspace_id"],
			["workspaces", "id"],
		].map(([table, column]) => count(table, `${column}='${ws}'`));

	it("removes one workspace's rows in every table and leaves the other workspace and shared rows", () => {
		const one = workspace("one");
		const two = workspace("two");
		for (const ws of [one, two]) {
			seedSession(`s-${ws}`, ws);
			seedBacklog(ws);
		}
		agent.db
			.prepare(
				"INSERT INTO memories(scope,repo_key,title,author,created_at,updated_at) VALUES ('project','k','p','u',1,1)",
			)
			.run();
		agent.db.prepare("INSERT INTO meta(key,value) VALUES ('memory_auto','on')").run();
		expect(owned(one).every((n) => n > 0)).toBe(true);
		const before = owned(two);
		const counts = purge.workspace(agent.db, one);
		expect(owned(one)).toEqual(owned(one).map(() => 0));
		expect(owned(two)).toEqual(before);
		expect(counts).toMatchObject({
			workspaces: 1,
			backlog: 1,
			sessions: 1,
			transcripts: 1,
			entries: 2,
			leases: 1,
			messages: 1,
		});
		expect(count("session_entries", "session_id = 's-two'")).toBe(2);
		expect(count("deliveries")).toBe(1);
		expect(count("memories", "scope='project'")).toBe(1);
		expect(count("meta", "key IN ('memory_auto','backlog_seq:two')")).toBe(2);
		expect(count("meta", "key='backlog_seq:one'")).toBe(0);
		// The audit guard is back exactly as it was.
		expect(() => agent.db.prepare("DELETE FROM backlog_audits").run()).toThrow(/immutable/);
		expect(purge.workspace(agent.db, "absent")).toMatchObject({ workspaces: 0, sessions: 0 });
	});

	it("keepSessions spares every per-session row of the kept session and the workspace row it references", () => {
		const one = workspace("one");
		const two = workspace("two");
		seedSession("cur", one);
		seedSession("old", one);
		seedSession("cur2", two);
		seedSession("old2", two);
		seedBacklog(one);
		seedBacklog(two);
		agent.db
			.prepare("INSERT INTO session_forks(child_id,parent_id,child_file) VALUES ('cur','old','/t/cur.jsonl')")
			.run();
		agent.db.prepare("UPDATE agents SET session_id = 'cur' WHERE id = 'agent-one'").run();
		const kept = (id: string) =>
			SESSION_TABLES.map((table) => count(table, `${table === "sessions" ? "id" : "session_id"} = '${id}'`));
		const before = kept("cur");
		const counts = purge.workspace(agent.db, one, { keepSessions: ["cur"] });
		expect(kept("cur")).toEqual(before);
		expect(kept("old")).toEqual(before.map(() => 0));
		expect(counts).toMatchObject({ sessions: 1, backlog: 1, workspaces: 0 });
		expect(count("workspaces", "id = 'one'")).toBe(1);
		expect(count("agents", "id = 'agent-one'")).toBe(1);
		expect(count("backlog", "workspace_id = 'one'")).toBe(0);
		// The edge to a purged parent goes with the parent; the other workspace is untouched.
		expect(count("session_forks")).toBe(0);
		expect(kept("cur2")).toEqual(before);
		expect(count("backlog", "workspace_id = 'two'")).toBe(1);
		agent.close();
		agent = openAgentDb(file);
		expect(count("sessions")).toBe(3);
	});

	it("purge.all with keepSessions leaves only the kept sessions, their workspaces, edges between them and settings", () => {
		const one = workspace("one");
		const two = workspace("two");
		seedSession("cur", one);
		seedSession("cur-parent", one);
		seedSession("other", two);
		seedBacklog(one);
		seedBacklog(two);
		agent.db
			.prepare("INSERT INTO session_forks(child_id,parent_id,child_file) VALUES ('cur','cur-parent','/t/cur.jsonl')")
			.run();
		agent.db.prepare("INSERT INTO meta(key,value) VALUES ('memory_auto','off')").run();
		const counts = purge.all(agent.db, { keepSessions: ["cur", "cur-parent"] });
		expect(counts).toMatchObject({ sessions: 1, workspaces: 1, backlog: 2 });
		expect(count("sessions")).toBe(2);
		expect(count("session_forks")).toBe(1);
		expect(count("workspaces")).toBe(1);
		expect(count("workspaces", "id = 'one'")).toBe(1);
		expect(SESSION_TABLES.map((table) => count(table))).toEqual([2, 2, 4, 2, 2, 2, 2]);
		expect(count("meta", "key = 'memory_auto'")).toBe(1);
		expect(count("backlog")).toBe(0);
		agent.close();
		agent = openAgentDb(file);
		expect(count("workspaces")).toBe(1);
	});

	it("empties every data table, keeps schema, triggers, settings and trust, and the file reopens", () => {
		for (const ws of [workspace("one"), workspace("two")]) {
			seedSession(`s-${ws}`, ws);
			seedBacklog(ws);
		}
		agent.db.prepare("INSERT INTO meta(key,value) VALUES ('memory_auto','off')").run();
		agent.db.prepare("INSERT INTO config_audits(at,actor,action,target,outcome) VALUES (1,'a','set','t','ok')").run();
		agent.db
			.prepare(
				"INSERT INTO trusted_folders(path,dev,ino,scope,source,surface,decided_by,decided_at) VALUES ('/p','1','2','folder','s','cli','u',1)",
			)
			.run();
		const objects = () => agent.db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
		const schema = objects();
		const counts = purge.all(agent.db);
		expect(counts).toMatchObject({ workspaces: 2, backlog: 2, config_audits: 1, session_entries: 4, sessions: 2 });
		const tables = (
			agent.db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memories_fts%'",
				)
				.all() as Array<{ name: string }>
		).map((row) => row.name);
		const left = Object.fromEntries(tables.map((name) => [name, count(name)]).filter(([, n]) => n !== 0));
		// `meta` keeps the schema version and the oldest version that may read the file.
		expect(left).toEqual({ meta: 2, trusted_folders: 1 });
		expect(objects()).toEqual(schema);
		agent.close();
		agent = openAgentDb(file);
		expect(count("workspaces")).toBe(0);
	});
});

describe("maintenance", () => {
	const bulk = () => {
		const ws = workspace("w");
		const text = "x".repeat(2000);
		agent.transaction(() => {
			const insert = agent.db.prepare("INSERT INTO edits(workspace_id,path,agent,tool,at) VALUES (?,?,'a','t',1)");
			for (let i = 0; i < 3000; i++) insert.run(ws, `${text}${i}`);
		});
		return ws;
	};

	it("shrinks the file after a purge: vacuum, then a truncating checkpoint", () => {
		const ws = bulk();
		maintenance.checkpoint(agent.db);
		const grown = fs.statSync(file).size;
		purge.workspace(agent.db, ws);
		const result = maintenance.vacuum(agent.db);
		expect(result).toMatchObject({ busy: false });
		expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
		expect(fs.statSync(file).size).toBeLessThan(grown / 2);
		expect(fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0).toBe(0);
	});

	it("reports a lock held by another connection as busy instead of throwing", () => {
		bulk();
		const other = openAgentDb(file);
		try {
			other.db.exec("BEGIN IMMEDIATE");
			expect(maintenance.vacuum(agent.db, 0)).toMatchObject({ busy: true });
			other.db.exec("ROLLBACK");
			other.db.exec("BEGIN");
			other.db.prepare("SELECT COUNT(*) FROM edits").get();
			agent.db
				.prepare(
					"INSERT INTO edits(workspace_id,path,agent,tool,at) SELECT workspace_id,'z','a','t',2 FROM edits LIMIT 1",
				)
				.run();
			expect(maintenance.checkpoint(agent.db, 0)).toMatchObject({ busy: true });
			other.db.exec("ROLLBACK");
			expect(maintenance.checkpoint(agent.db, 0)).toMatchObject({ busy: false });
		} finally {
			other.close();
		}
		expect(() => agent.transaction(() => maintenance.vacuum(agent.db))).toThrow(/transaction/);
	});
});

describe("expire", () => {
	it("drops transcripts and events of the named sessions only when their own timestamps are older than the cutoff", () => {
		const ws = workspace("w");
		const cutoff = 10_000_000;
		seedSession("old", ws, String(1_000 * 1_000_000));
		seedSession("recent", ws, String((cutoff + 1) * 1_000_000));
		seedSession("present", ws, String(1_000 * 1_000_000));
		agent.db
			.prepare(
				"INSERT INTO agent_events(id,workspace_id,time,session_id,type,data,version) VALUES ('new-ev',?,?,'old','init','{}',1)",
			)
			.run(ws, new Date(cutoff + 5).toISOString());
		const counts = expire.orphans(agent.db, ["old", "recent", "unknown"], cutoff);
		// Events follow their own time, not the transcript's: ev-old and ev-recent are both older than the cutoff.
		expect(counts).toEqual({ transcripts: 1, entries: 2, events: 2, timers: 0 });
		expect(count("session_transcripts")).toBe(2);
		expect(count("session_entries", "session_id='old'")).toBe(0);
		expect(count("agent_events", "id IN ('new-ev','ev-present')")).toBe(2);
		expect(count("sessions")).toBe(3);
		expect(expire.orphans(agent.db, [], cutoff)).toEqual({ transcripts: 0, entries: 0, events: 0, timers: 0 });
	});
});

describe("history windows", () => {
	const NOW = Date.UTC(2026, 10, 10, 12);
	const audit = (age: number) =>
		agent.db
			.prepare("INSERT INTO config_audits(at,actor,action,target,outcome) VALUES (?,'a','set','t','ok')")
			.run(NOW - age * DAY_MS);
	const archived = () => (fs.existsSync(agent.archiveDir) ? fs.readdirSync(agent.archiveDir) : []);

	it("keeps the documented defaults", () => {
		expect(DEFAULT_HISTORY_WINDOWS).toEqual({ archiveAfterDays: 14, keepDays: 30 });
		audit(10);
		audit(20);
		audit(40);
		expect(archiveHistory(agent, NOW)).toMatchObject({ archived: 1, deleted: 2 });
	});

	it("applies the windows the caller passes, and 0 keeps archived rows forever", () => {
		audit(10);
		audit(100);
		expect(archiveHistory(agent, NOW, { archiveAfterDays: 5, keepDays: 60 })).toMatchObject({
			archived: 1,
			deleted: 2,
		});
		expect(count("config_audits")).toBe(0);
		audit(400);
		expect(archiveHistory(agent, NOW, { archiveAfterDays: 14, keepDays: 0 })).toMatchObject({
			archived: 1,
			deleted: 1,
		});
		expect(archived().length).toBeGreaterThan(0);
	});

	it("never lets the archive window outlast a shorter keep window", () => {
		audit(10);
		audit(3);
		expect(archiveHistory(agent, NOW, { archiveAfterDays: 14, keepDays: 7 })).toMatchObject({
			archived: 0,
			deleted: 1,
		});
		expect(count("config_audits")).toBe(1);
		expect(() => archiveHistory(agent, NOW, { archiveAfterDays: 14, keepDays: -1 })).toThrow(
			/Invalid retention window/,
		);
	});
});
