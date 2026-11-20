import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, type AgentDb } from "../src/db.ts";
import * as jobs from "../src/queries/jobs.ts";
import * as leases from "../src/queries/leases.ts";
import { tmp } from "./helpers.ts";

const file = () => path.join(tmp("db-jobs-"), "workspaces.db");

function open(): AgentDb {
	const target = file();
	const agent = openDatabase({
		file: target,
		mirrorFile: `${target}.transcripts`,
		archiveDir: path.join(path.dirname(target), "archive"),
		privateParent: false,
	});
	agent.db.exec(`
		INSERT INTO workspaces (id, name, root, binding) VALUES ('w1', 'repo', '/repo', '1:1'), ('w2', 'other', '/other', '1:2');`);
	return agent;
}

const start = (job: string, over: Partial<jobs.NewJob> = {}): jobs.NewJob => ({
	workspaceId: "w1",
	sessionId: "s1",
	job,
	command: "yarn run check",
	cwd: "/repo",
	key: "k1",
	pid: 100,
	log: `/logs/${job}.log`,
	at: 1_000,
	...over,
});

describe("jobs", () => {
	it("finds running jobs by workspace and key, oldest first, never an ended one", () => {
		const agent = open();
		try {
			jobs.insert(agent.db, start("bash-1"));
			jobs.insert(agent.db, start("bash-2", { sessionId: "s2", agent: "swift-orca", item: "B915" }));
			jobs.insert(agent.db, start("bash-3", { key: "k2" }));
			jobs.insert(agent.db, start("bash-4", { workspaceId: "w2" }));
			expect(jobs.runningByKey(agent.db, "w1", "k1").map((row) => [row.session_id, row.job])).toEqual([
				["s1", "bash-1"],
				["s2", "bash-2"],
			]);
			expect(jobs.runningByKey(agent.db, "w1", "k1")[1]).toMatchObject({ agent: "swift-orca", item: "B915" });
			expect(jobs.end(agent.db, "s1", "bash-1", "finished", 0, 2_000)).toBe(true);
			expect(jobs.runningByKey(agent.db, "w1", "k1").map((row) => row.job)).toEqual(["bash-2"]);
			expect(jobs.running(agent.db, "w1").map((row) => row.job)).toEqual(["bash-2", "bash-3"]);
			expect(jobs.bySessionJob(agent.db, "s1", "bash-1")).toMatchObject({
				state: "finished",
				exit_code: 0,
				ended_at: 2_000,
			});
		} finally {
			agent.close();
		}
	});

	it("ends a job once, and lets a restarted session reuse a job id for its new job", () => {
		const agent = open();
		try {
			jobs.insert(agent.db, start("bash-1"));
			expect(jobs.end(agent.db, "s1", "bash-1", "stopped", null, 2_000)).toBe(true);
			expect(jobs.end(agent.db, "s1", "bash-1", "finished", 0, 3_000)).toBe(false);
			expect(jobs.bySessionJob(agent.db, "s1", "bash-1")).toMatchObject({ state: "stopped", exit_code: null });
			jobs.insert(agent.db, start("bash-1", { command: "yarn test", pid: 200, at: 5_000 }));
			expect(jobs.bySessionJob(agent.db, "s1", "bash-1")).toMatchObject({
				state: "running",
				command: "yarn test",
				pid: 200,
				ended_at: null,
				started_at: 5_000,
			});
		} finally {
			agent.close();
		}
	});

	it("drops ended jobs and abandoned running ones past the cutoff, and keeps the rest", () => {
		const agent = open();
		try {
			jobs.insert(agent.db, start("bash-1", { at: 100 }));
			jobs.insert(agent.db, start("bash-2", { at: 100 }));
			jobs.insert(agent.db, start("bash-3", { at: 900 }));
			jobs.insert(agent.db, start("bash-4", { at: 100 }));
			jobs.end(agent.db, "s1", "bash-1", "finished", 0, 200);
			jobs.end(agent.db, "s1", "bash-4", "finished", 0, 800);
			expect(jobs.purgeBefore(agent.db, 500)).toBe(2);
			expect(
				(agent.db.prepare("SELECT job FROM jobs ORDER BY id").all() as { job: string }[]).map((row) => row.job),
			).toEqual(["bash-3", "bash-4"]);
		} finally {
			agent.close();
		}
	});
});

describe("lease item", () => {
	it("is stored with a new lease, kept by a renewal that names none and replaced by one that does", () => {
		const agent = open();
		try {
			const lease = { path: "src", pathKey: "src", kind: "tree", reason: "edit" };
			leases.insert(agent.db, "w1", "a1", { ...lease, item: "B915" }, 1_000, 2_000);
			leases.insert(agent.db, "w1", "a1", { ...lease, pathKey: "doc", path: "doc" }, 1_000, 2_000);
			const item = (key: string) =>
				(agent.db.prepare("SELECT item FROM leases WHERE path_key = ?").get(key) as { item: string | null }).item;
			expect(item("src")).toBe("B915");
			expect(item("doc")).toBeNull();
			const id = leases.heldId(agent.db, "/repo", "a1", "src", "tree", 1_500)!;
			leases.renew(agent.db, id, "still editing", 3_000);
			expect(item("src")).toBe("B915");
			leases.renew(agent.db, id, "moved on", 3_000, "B916");
			expect(item("src")).toBe("B916");
		} finally {
			agent.close();
		}
	});
});
