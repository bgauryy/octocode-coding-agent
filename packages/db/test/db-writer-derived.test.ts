import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb, DbWriter, type DbWriterLocations, memories, openDatabase, sessions } from "../src/api.ts";
import { tmp } from "./helpers.ts";

let locations: DbWriterLocations;
let writers: DbWriter[];
beforeEach(() => {
	const dir = tmp();
	locations = {
		file: path.join(dir, "writer.db"),
		mirrorFile: path.join(dir, "writer.transcripts.db"),
		archiveDir: path.join(dir, "archive"),
		privateParent: false,
	};
	writers = [];
});
afterEach(() => {
	for (const writer of writers) writer.close();
	closeSharedAgentDb();
});

const writer = () => {
	const made = new DbWriter(locations);
	writers.push(made);
	return made;
};

/** Another process holding the write lock for `ms`; resolves once it holds it. */
async function holdLock(ms: number) {
	const holder = spawn(
		process.execPath,
		[
			"-e",
			`const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(locations.file)});
			 db.exec("BEGIN IMMEDIATE"); process.stdout.write("held\\n"); setTimeout(() => db.exec("COMMIT"), ${ms});`,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
	return { released: new Promise<void>((resolve) => holder.once("exit", () => resolve())) };
}

const stats = (tokens: number) => ({
	cost: 0,
	tokens,
	filesChanged: 0,
	unpriced: false,
	branch: null,
	head: null,
	pid: process.pid,
	pidStarted: null,
});

describe("database writer bookkeeping commands", () => {
	it("commits a turn's session writes in the order posted, so the end is never undone by the stats before it", async () => {
		const agent = openDatabase(locations);
		try {
			sessions.start(agent.db, "s1", process.pid, null, null);
			const db = writer();
			const posted = [
				db.post({ kind: "session-stats", id: "s1", stats: stats(42) }),
				db.post({ kind: "session-git", id: "s1", branch: "main", head: "abc" }),
				db.post({ kind: "session-end", id: "s1", pid: process.pid }),
			];
			await Promise.all(posted);
			expect(sessions.byId(agent.db, "s1")).toMatchObject({ tokens: 42, branch: "main", head: "abc", pid: null });
		} finally {
			agent.close();
		}
	});

	it("waits for another process's lock on its own thread: a recalled memory's mark never stalls this one", async () => {
		const agent = openDatabase(locations);
		try {
			const id = memories.insert(agent.db, {
				scope: "global",
				repoKey: null,
				workspaceId: null,
				kind: "fact",
				title: "t",
				body: "b",
				keywords: "",
				pinned: false,
				author: "user",
				sourceSession: null,
				now: 1,
			});
			const db = writer();
			// Start the worker and its connection before the lock is taken.
			await db.post({ kind: "memory-used", context: { repoKey: "r" }, ids: [id], now: 2 });
			const { released } = await holdLock(400);
			const started = performance.now();
			const timer = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - started), 10));
			const marked = db.post({ kind: "memory-used", context: { repoKey: "r" }, ids: [id], now: 5000 });
			expect(await timer).toBeLessThan(150);
			await marked;
			expect(performance.now() - started).toBeGreaterThan(200);
			expect(memories.visible(agent.db, { repoKey: "r" }, id)).toMatchObject({ use_count: 2, last_used: 5000 });
			await released;
		} finally {
			agent.close();
		}
	});
});
