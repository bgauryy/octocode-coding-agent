import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTIVITY_TONES } from "@octocodeai/octocode-contracts";
import { closeSharedAgentDb, DbWriter, openDatabase, sessions } from "../src/api.ts";
import { loadSqlite } from "../src/sqlite.ts";
import { tmp } from "./helpers.ts";

const { DatabaseSync } = loadSqlite();

const locations = () => {
	const dir = tmp();
	return {
		file: path.join(dir, "workspaces.db"),
		mirrorFile: path.join(dir, "workspaces.transcripts.db"),
		archiveDir: path.join(dir, "archive"),
		privateParent: false,
	};
};
const writers: DbWriter[] = [];
afterEach(() => {
	for (const writer of writers.splice(0)) writer.close();
	closeSharedAgentDb();
});

/**
 * `sessions.activity`: the last light tone of a live session, written by the process that has it open when the tone
 * changes, so another process (`/resume`, `coordinate list`) can show what it is doing. Readers trust it only while the
 * row's pid is alive; the owner's start sets it idle and its end clears it.
 */
describe("a session's activity light in the agent database", () => {
	it("is written only by the process that has the session open, idle at its start and cleared at its end", () => {
		const agent = openDatabase(locations());
		try {
			sessions.start(agent.db, "s1", 41, "t41", null);
			expect(sessions.byId(agent.db, "s1")?.activity).toBe("idle");
			sessions.setActivity(agent.db, "s1", 41, "waiting");
			expect(sessions.byId(agent.db, "s1")?.activity).toBe("waiting");
			// Another process (an older run of the session, a stale writer) cannot change the light of the owner.
			sessions.setActivity(agent.db, "s1", 42, "working");
			expect(sessions.byId(agent.db, "s1")?.activity).toBe("waiting");
			// A new owner starts idle: what a crashed process last wrote is not its state.
			sessions.start(agent.db, "s1", 43, "t43", null);
			expect(sessions.byId(agent.db, "s1")?.activity).toBe("idle");
			sessions.setActivity(agent.db, "s1", 43, "error");
			sessions.clearPid(agent.db, "s1", 43);
			expect(sessions.byId(agent.db, "s1")).toMatchObject({ pid: null, activity: null });
		} finally {
			agent.close();
		}
	});

	it("shows no light an earlier process wrote once another process owns the row (an older build's start keeps it)", () => {
		const agent = openDatabase(locations());
		try {
			sessions.start(agent.db, "s1", 41, "t41", null);
			sessions.setActivity(agent.db, "s1", 41, "waiting");
			// That process crashed; an older Octocode resumes the session with its own start, which knows no light.
			agent.db
				.prepare(
					"INSERT INTO sessions (id, pid, pid_started, dir) VALUES ('s1', 42, 't42', NULL) ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, pid_started = excluded.pid_started",
				)
				.run();
			expect(sessions.byId(agent.db, "s1")).toMatchObject({ pid: 42, activity: null });
			expect(sessions.all(agent.db).find((row) => row.id === "s1")?.activity).toBeNull();
			// The same pid reused by another process (another start time) is not the writer either.
			sessions.start(agent.db, "s2", 43, "t43", null);
			sessions.setActivity(agent.db, "s2", 43, "working");
			agent.db.prepare("UPDATE sessions SET pid_started = 't43-later' WHERE id = 's2'").run();
			expect(sessions.byId(agent.db, "s2")?.activity).toBeNull();
			// A process whose start time is unknown still owns the light it wrote.
			sessions.start(agent.db, "s3", 44, null, null);
			sessions.setActivity(agent.db, "s3", 44, "error");
			expect(sessions.byId(agent.db, "s3")?.activity).toBe("error");
		} finally {
			agent.close();
		}
	});

	it("holds exactly the light's tones", () => {
		const agent = openDatabase(locations());
		try {
			sessions.start(agent.db, "s1", 41, null, null);
			for (const tone of ACTIVITY_TONES) {
				sessions.setActivity(agent.db, "s1", 41, tone);
				expect(sessions.byId(agent.db, "s1")?.activity).toBe(tone);
			}
			expect(() => sessions.setActivity(agent.db, "s1", 41, "busy" as never)).toThrow(/CHECK constraint/);
		} finally {
			agent.close();
		}
	});

	it("is added to a version-10 file made before the column, once, when the file is opened", () => {
		const where = locations();
		openDatabase(where).close();
		const raw = new DatabaseSync(where.file);
		raw.exec(
			"ALTER TABLE sessions DROP COLUMN activity_by; ALTER TABLE sessions DROP COLUMN activity; PRAGMA user_version=10",
		);
		raw.prepare("INSERT INTO sessions (id, pid) VALUES ('old', 7)").run();
		raw.close();
		const first = openDatabase(where);
		const second = openDatabase(where);
		try {
			expect(sessions.byId(first.db, "old")).toMatchObject({ pid: 7, activity: null });
			sessions.setActivity(second.db, "old", 7, "working");
			expect(sessions.byId(first.db, "old")?.activity).toBe("working");
		} finally {
			first.close();
			second.close();
		}
	});

	it("goes through the database writer in order with the session's other bookkeeping", async () => {
		const where = locations();
		const agent = openDatabase(where);
		try {
			sessions.start(agent.db, "s1", process.pid, null, null);
			const writer = new DbWriter(where);
			writers.push(writer);
			await Promise.all([
				writer.post({ kind: "session-activity", id: "s1", pid: process.pid, activity: "working" }),
				writer.post({ kind: "session-activity", id: "s1", pid: process.pid, activity: "waiting" }),
			]);
			expect(sessions.byId(agent.db, "s1")?.activity).toBe("waiting");
			await writer.post({ kind: "session-end", id: "s1", pid: process.pid });
			expect(sessions.byId(agent.db, "s1")?.activity).toBeNull();
		} finally {
			agent.close();
		}
	});
});
