import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, type AgentDb } from "../src/db.ts";
import * as jobs from "../src/queries/jobs.ts";
import * as purge from "../src/queries/purge.ts";
import * as sessions from "../src/queries/sessions.ts";
import { tmp } from "./helpers.ts";

function open(): AgentDb {
	const target = path.join(tmp("db-b2-"), "workspaces.db");
	const agent = openDatabase({
		file: target,
		mirrorFile: `${target}.transcripts`,
		archiveDir: path.join(path.dirname(target), "archive"),
		privateParent: false,
	});
	agent.db.exec("INSERT INTO workspaces (id, name, root, binding) VALUES ('w1', 'repo', '/repo', '1:1');");
	return agent;
}

const entry = (cwd: string, file: string, title: string): sessions.CatalogEntry => ({
	title,
	titleSource: null,
	cwd,
	file,
	parentFile: null,
	createdAt: 1,
	lastActive: 1,
	messageCount: 1,
	firstPrompt: null,
	fileMtime: 1,
});

describe("sessions database safety", () => {
	it("keeps a catalog row when a copy of its file in another folder reuses the id", () => {
		const agent = open();
		try {
			sessions.saveCatalog(agent.db, "s1", entry("/repo", "/repo/s1.jsonl", "original"));
			sessions.saveCatalog(agent.db, "s1", entry("/elsewhere", "/elsewhere/s1.jsonl", "copy"));
			expect(sessions.catalog(agent.db).map((row) => [row.cwd, row.title])).toEqual([["/repo", "original"]]);
			sessions.saveCatalog(agent.db, "s1", entry("/repo", "/repo/s1.jsonl", "renamed"));
			expect(sessions.catalog(agent.db)[0]?.title).toBe("renamed");
		} finally {
			agent.close();
		}
	});

	it("keeps a title when a rename comes from a copy of the session in another folder", () => {
		const agent = open();
		try {
			sessions.saveCatalog(agent.db, "s1", entry("/repo", "/repo/s1.jsonl", "original"));
			sessions.saveTitle(agent.db, "s1", "copy", null, 2, { cwd: "/elsewhere", file: "/elsewhere/s1.jsonl" });
			expect(sessions.catalog(agent.db)[0]?.title).toBe("original");
			sessions.saveTitle(agent.db, "s1", "renamed", null, 2, { cwd: "/repo", file: "/repo/s1.jsonl" });
			expect(sessions.catalog(agent.db)[0]?.title).toBe("renamed");
		} finally {
			agent.close();
		}
	});

	it("purges spare a session whose process is live when the purge starts", () => {
		const agent = open();
		try {
			for (const id of ["live", "dead"]) {
				sessions.bind(agent.db, id, "w1");
				sessions.start(agent.db, id, id === "live" ? 111 : 222, null, null);
			}
			purge.workspace(agent.db, agent.mirror.db, "w1", { isLive: (pid) => pid === 111 });
			expect(sessions.all(agent.db).map((row) => row.id)).toEqual(["live"]);
		} finally {
			agent.close();
		}
	});

	it("retention deletes a stale running job only when its process is gone", () => {
		const agent = open();
		try {
			const base = { workspaceId: "w1", sessionId: "s1", command: "x", cwd: "/", key: "k", log: "/l", at: 1 };
			jobs.insert(agent.db, { ...base, job: "alive", pid: process.pid });
			jobs.insert(agent.db, { ...base, job: "gone", pid: 2 ** 22 + 12345 });
			expect(jobs.purgeBefore(agent.db, 1_000)).toBe(1);
			expect(
				agent.db
					.prepare("SELECT job FROM jobs")
					.all()
					.map((row) => row.job),
			).toEqual(["alive"]);
		} finally {
			agent.close();
		}
	});
});
