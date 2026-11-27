import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentDb, openDatabase } from "../src/db.ts";
import { inTransaction } from "../src/queries/transaction.ts";
import { beginImmediate, isBusy, loadSqlite } from "../src/sqlite.ts";
import { tmp } from "./helpers.ts";

let file: string;
let opened: { close(): void }[];
let holders = 0;
beforeEach(() => {
	file = path.join(tmp(), "begin.db");
	opened = [];
});
afterEach(() => {
	for (const each of opened) each.close();
});

function agentDb(): AgentDb {
	const dir = path.dirname(file);
	const agent = openDatabase({
		file,
		mirrorFile: path.join(dir, "begin.transcripts.db"),
		archiveDir: path.join(dir, "archive"),
		privateParent: false,
	});
	opened.push(agent);
	return agent;
}

function connection(busyMs: number): DatabaseSync {
	const db = new (loadSqlite().DatabaseSync)(file);
	opened.push(db);
	db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=${busyMs}`);
	return db;
}

const timeout = (db: DatabaseSync) => (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;

/**
 * Another process holding the write lock. It commits `ms` after `release` (or once `ms` passed, without it) and reports
 * the wall time it committed. `release` writes a file it polls, so it works while this thread is blocked in a wait.
 */
async function holdLock(ms: number) {
	const signal = `${file}.release-${++holders}`;
	const holder = spawn(
		process.execPath,
		[
			"-e",
			`const fs = require("node:fs"); const { DatabaseSync } = require("node:sqlite");
			 const db = new DatabaseSync(${JSON.stringify(file)});
			 db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE"); process.stdout.write("held\\n");
			 const commit = () => { db.exec("COMMIT"); process.stdout.write("released " + Date.now() + "\\n"); };
			 const poll = setInterval(() => {
			   if (!fs.existsSync(${JSON.stringify(signal)})) return;
			   clearInterval(poll); clearTimeout(fallback);
			   setTimeout(commit, Number(fs.readFileSync(${JSON.stringify(signal)}, "utf8")) - Date.now());
			 }, 1);
			 const fallback = setTimeout(() => { clearInterval(poll); commit(); }, ${ms});`,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	opened.push({ close: () => holder.exitCode === null && holder.kill() });
	let out = "";
	holder.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
	await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
	return {
		/** The holder commits `after` ms from now. */
		release: (after: number) => fs.writeFileSync(signal, String(Date.now() + after)),
		released: () =>
			new Promise<number>((resolve) => {
				const check = () => {
					const found = /released (\d+)/.exec(out);
					if (found) resolve(Number(found[1]));
					else holder.stdout.once("data", check);
				};
				check();
			}),
	};
}

/** Runs `work`, returning what it threw and how long it took. */
function failure(work: () => unknown): { error: unknown; ms: number } {
	const start = performance.now();
	try {
		work();
	} catch (error) {
		return { error, ms: performance.now() - start };
	}
	throw new Error("expected the work to throw");
}

describe("beginImmediate", () => {
	it("opens the transaction and leaves the connection's busy_timeout as it was", () => {
		const db = connection(1234);
		beginImmediate(db);
		expect(db.isTransaction).toBe(true);
		expect(timeout(db)).toBe(1234);
		db.exec("ROLLBACK");
	});

	it("throws a non-busy error at once without retrying, and restores the timeout", () => {
		const db = connection(5000);
		db.exec("BEGIN");
		const { error, ms } = failure(() => beginImmediate(db));
		expect(isBusy(error)).toBe(false);
		expect(String(error)).toMatch(/within a transaction/);
		expect(ms).toBeLessThan(1000);
		expect(timeout(db)).toBe(5000);
		db.exec("ROLLBACK");
	});

	it("takes a lock released mid-wait within milliseconds, not at SQLite's next backoff step", async () => {
		const agent = agentDb();
		// SQLite's own handler tries at 0, 1, 3, 8, 18, 33, 53, 78, 103, 128, 178, 228, 328, 428 … ms of its wait, its sleeps
		// overshooting under load: a release 370+ ms in is seen anywhere up to 100 ms late there. Three releases at other
		// offsets all seen within 30 ms would be luck for that handler.
		const lags: number[] = [];
		for (const after of [370, 410, 450]) {
			const lock = await holdLock(10_000);
			lock.release(after);
			let acquired = 0;
			agent.transaction(() => {
				acquired = Date.now();
			});
			lags.push(acquired - (await lock.released()));
		}
		expect(Math.min(...lags)).toBeGreaterThanOrEqual(-2);
		expect(Math.max(...lags)).toBeLessThan(30);
		expect(timeout(agent.db)).toBe(5000);
	});

	it("fails with the same SQLITE_BUSY as SQLite's own wait once a lock outlasts the budget", async () => {
		await holdLock(10_000);
		const db = connection(200);
		const today = failure(() => db.exec("BEGIN IMMEDIATE"));
		const now = failure(() => beginImmediate(db));
		expect(isBusy(now.error)).toBe(true);
		expect((now.error as { errcode: number }).errcode).toBe((today.error as { errcode: number }).errcode);
		expect((now.error as Error).message).toBe((today.error as Error).message);
		expect(now.ms).toBeGreaterThanOrEqual(195);
		expect(now.ms).toBeLessThan(2000);
		expect(db.isTransaction).toBe(false);
		expect(timeout(db)).toBe(200);
	});

	it("tries once when the connection's busy_timeout is 0", async () => {
		await holdLock(10_000);
		const db = connection(0);
		const { error, ms } = failure(() => beginImmediate(db));
		expect(isBusy(error)).toBe(true);
		expect(ms).toBeLessThan(100);
		expect(timeout(db)).toBe(0);
	});

	it("leaves no transaction behind when AgentDb.transaction or inTransaction gives up", async () => {
		const agent = agentDb();
		await holdLock(10_000);
		agent.db.exec("PRAGMA busy_timeout=100");
		let ran = false;
		expect(isBusy(failure(() => agent.transaction(() => (ran = true))).error)).toBe(true);
		expect(isBusy(failure(() => inTransaction(agent.db, () => (ran = true))).error)).toBe(true);
		expect(ran).toBe(false);
		expect(agent.db.isTransaction).toBe(false);
		expect(timeout(agent.db)).toBe(100);
	});

	it("joins the caller's transaction when nested", () => {
		const agent = agentDb();
		const result = agent.transaction(() =>
			agent.transaction(() => inTransaction(agent.db, () => agent.db.isTransaction)),
		);
		expect(result).toBe(true);
		expect(agent.db.isTransaction).toBe(false);
	});
});
