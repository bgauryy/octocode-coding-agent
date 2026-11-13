import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { threadId } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { closeSharedConnections, dbStamp, openDatabase, sharedDatabase, type AgentDb } from "../src/db.ts";
import { AgentDbMigratingError, backUp, prepareSchema } from "../src/migrate.ts";
import { FIRST_SCHEMA_VERSION, SCHEMA_PLAN, type Migration, type SchemaPlan } from "../src/migrations.ts";
import { AgentDbError, COORDINATION_FILE } from "../src/schema.ts";
import { isBusy, loadSqlite } from "../src/sqlite.ts";
import { tmp } from "./helpers.ts";

/** These plans have no step that opens the transcript mirror. */
const openMirror = (): never => {
	throw new Error("no mirror in this test");
};

const { DatabaseSync } = loadSqlite();

const open = (file: string, plan?: SchemaPlan): AgentDb =>
	openDatabase(
		{
			file,
			mirrorFile: `${file}.transcripts`,
			archiveDir: path.join(path.dirname(file), "archive"),
			privateParent: false,
		},
		plan,
	);

/** A database as this Octocode creates it today, with a row that must survive, closed. */
function versionOne(): string {
	const file = path.join(tmp(), "workspaces.db");
	const agent = open(file, { version: 1, migrations: [] });
	agent.db.prepare("INSERT INTO meta (key, value) VALUES ('keep', 'me')").run();
	agent.close();
	return file;
}

const addTable = (to: number, additive = true, calls: number[] = []): Migration => ({
	to,
	additive,
	up: (db) => {
		calls.push(to);
		db.exec(`CREATE TABLE step_${to} (x)`);
	},
});

const versionOf = (file: string) => {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
	} finally {
		db.close();
	}
};

const metaValue = (file: string, key: string) => {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
	} finally {
		db.close();
	}
};

const tables = (file: string) => {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]).map(
			(row) => row.name,
		);
	} finally {
		db.close();
	}
};

describe("agent database migrations", () => {
	it("the shipped plan ends at its own version, with no gap", () => {
		const newest = SCHEMA_PLAN.migrations.at(-1)?.to ?? FIRST_SCHEMA_VERSION;
		expect(newest).toBe(SCHEMA_PLAN.version);
		expect(SCHEMA_PLAN.migrations.map((step) => step.to)).toEqual(
			Array.from({ length: SCHEMA_PLAN.version - FIRST_SCHEMA_VERSION }, (_, at) => FIRST_SCHEMA_VERSION + at + 1),
		);
	});

	it("runs the steps in order, keeps the data and leaves a private backup at the old version", () => {
		const file = versionOne();
		const calls: number[] = [];
		const agent = open(file, { version: 3, migrations: [addTable(3, true, calls), addTable(2, true, calls)] });
		agent.close();
		expect(calls).toEqual([2, 3]);
		expect(versionOf(file)).toBe(3);
		expect(metaValue(file, "keep")).toBe("me");
		const backup = `${file}.v1.bak`;
		expect(versionOf(backup)).toBe(1);
		expect(metaValue(backup, "keep")).toBe("me");
		expect(tables(backup)).not.toContain("step_2");
		if (process.platform !== "win32") expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
		// No leftover of the copy, and a later open has nothing more to do.
		expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		open(file, { version: 3, migrations: [addTable(3, true, calls), addTable(2, true, calls)] }).close();
		expect(calls).toEqual([2, 3]);
	});

	it("rolls back only the failing step, names the backup and the version, and finishes once the step works", () => {
		const file = versionOne();
		const failing: Migration = {
			to: 3,
			additive: true,
			up: (db) => {
				db.exec("CREATE TABLE half_done (x)");
				throw new Error("disk trouble");
			},
		};
		const plan = { version: 3, migrations: [addTable(2), failing] };
		const attempt = () => open(file, plan);
		expect(attempt).toThrow(AgentDbError);
		expect(attempt).toThrow(/stays at version 2.*A backup is at .*\.v2\.bak/);
		expect(versionOf(file)).toBe(2);
		expect(tables(file)).toContain("step_2");
		expect(tables(file)).not.toContain("half_done");
		expect(metaValue(file, "keep")).toBe("me");
		// The first backup still shows the version the file had before any step ran.
		expect(versionOf(`${file}.v1.bak`)).toBe(1);
		open(file, { version: 3, migrations: [addTable(2), addTable(3)] }).close();
		expect(versionOf(file)).toBe(3);
	});

	it("does not run a step when the backup cannot be written", () => {
		const file = versionOne();
		fs.mkdirSync(`${file}.v1.bak.${process.pid}.${threadId}.tmp`);
		fs.writeFileSync(path.join(`${file}.v1.bak.${process.pid}.${threadId}.tmp`, "occupied"), "x");
		const calls: number[] = [];
		expect(() => open(file, { version: 2, migrations: [addTable(2, true, calls)] })).toThrow(/its backup failed/);
		expect(calls).toEqual([]);
		expect(versionOf(file)).toBe(1);
	});

	it("writes the copy under a name of this thread's own, replacing a file an ended run left there", () => {
		const file = versionOne();
		const partial = `${file}.v1.bak.${process.pid}.${threadId}.tmp`;
		fs.writeFileSync(partial, "left by a run that ended");
		open(file, { version: 2, migrations: [addTable(2)] }).close();
		expect(versionOf(`${file}.v1.bak`)).toBe(1);
		expect(metaValue(`${file}.v1.bak`, "keep")).toBe("me");
		expect(fs.existsSync(partial)).toBe(false);
	});

	it("never renames a copy that is not a whole database over a good backup", () => {
		const file = versionOne();
		const backup = `${file}.v1.bak`;
		fs.copyFileSync(file, backup);
		const good = fs.readFileSync(backup);
		const partial = `${file}.v1.bak.${process.pid}.${threadId}.tmp`;
		const tearing: Migration = {
			...addTable(2),
			backup: () => {
				// A torn copy: its pages past the header overwritten, and its change counter moved so SQLite reads them again.
				const fd = fs.openSync(partial, "r+");
				try {
					fs.writeSync(fd, Buffer.alloc(4096 - 100, 0xa5), 0, 4096 - 100, 100);
					fs.writeSync(fd, Buffer.from([0xff, 0xff, 0xff, 0xff]), 0, 4, 24);
				} finally {
					fs.closeSync(fd);
				}
			},
		};
		expect(() => open(file, { version: 2, migrations: [tearing] })).toThrow(/its backup failed/);
		expect(fs.readFileSync(backup).equals(good)).toBe(true);
		expect(versionOf(file)).toBe(1);
		expect(fs.existsSync(partial)).toBe(false);
	});

	it("backs up what another session has committed only to the WAL, while that session stays open", () => {
		const file = versionOne();
		const peer = new DatabaseSync(file);
		try {
			peer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
			peer.prepare("INSERT INTO meta (key, value) VALUES ('in-wal', 'yes')").run();
			expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);
			open(file, { version: 2, migrations: [addTable(2)] }).close();
			expect(metaValue(`${file}.v1.bak`, "in-wal")).toBe("yes");
			// The peer goes on writing the migrated file.
			peer.prepare("INSERT INTO meta (key, value) VALUES ('after', 'yes')").run();
		} finally {
			peer.close();
		}
		expect(metaValue(file, "after")).toBe("yes");
		expect(versionOf(file)).toBe(2);
	});

	it("rechecks the version once it holds the lock: a step another process just ran does not run again", () => {
		const file = versionOne();
		const calls: number[] = [];
		const plan = { version: 2, migrations: [addTable(2, true, calls)] };
		const mine = new DatabaseSync(file);
		const transaction = <T>(fn: () => T): T => {
			// Between this process's unlocked read and its lock, a peer migrates.
			const peer = new DatabaseSync(file);
			peer.exec("BEGIN IMMEDIATE; CREATE TABLE step_2 (x); PRAGMA user_version=2; COMMIT;");
			peer.close();
			mine.exec("BEGIN IMMEDIATE");
			const result = fn();
			mine.exec("COMMIT");
			return result;
		};
		expect(prepareSchema(mine, file, transaction, plan, COORDINATION_FILE, { openMirror })).toEqual({
			fts: expect.any(Boolean),
		});
		mine.close();
		expect(calls).toEqual([]);
		expect(versionOf(file)).toBe(2);
	});

	it("discards a snapshot that no longer shows the version it was taken for", () => {
		const file = versionOne();
		const db = new DatabaseSync(file);
		db.exec("PRAGMA user_version=2");
		expect(backUp(file, 1)).toBeUndefined();
		db.close();
		expect(fs.readdirSync(path.dirname(file)).filter((name) => /\.bak|\.tmp/.test(name))).toEqual([]);
	});

	it("several real processes opening an old file at once run each step exactly once", async () => {
		const file = versionOne();
		const dbModule = pathToFileURL(fileURLToPath(new URL("../src/db.ts", import.meta.url))).href;
		// ALTER TABLE fails if it runs twice, and the insert counts the runs.
		const script = `
			const { openDatabase } = await import(${JSON.stringify(dbModule)});
			const agent = openDatabase({ file: ${JSON.stringify(file)}, mirrorFile: ${JSON.stringify(`${file}.transcripts`)}, archiveDir: ${JSON.stringify(path.dirname(file))}, privateParent: false }, {
				version: 2,
				migrations: [{ to: 2, additive: true, up: (db) => {
					db.exec("CREATE TABLE ran (pid); ALTER TABLE ran ADD COLUMN once");
					db.prepare("INSERT INTO ran (pid) VALUES (?)").run(process.pid);
				} }],
			});
			agent.close();`;
		const results = await Promise.all(
			Array.from(
				{ length: 4 },
				() =>
					new Promise<string | undefined>((resolve) => {
						execFile(
							process.execPath,
							["--no-warnings", "--input-type=module", "-e", script],
							{ encoding: "utf8" },
							(error, _stdout, stderr) => resolve(error ? stderr : undefined),
						);
					}),
			),
		);
		expect(results).toEqual([undefined, undefined, undefined, undefined]);
		expect(versionOf(file)).toBe(2);
		const db = new DatabaseSync(file, { readOnly: true });
		expect(db.prepare("SELECT count(*) AS runs FROM ran").get()).toEqual({ runs: 1 });
		db.close();
	}, 60_000);
});

/** Another process holding `file`'s write lock until it is told to end, then running `sql` before its commit. */
async function holdLock(file: string, sql = "") {
	const holder = spawn(
		process.execPath,
		[
			"--no-warnings",
			"-e",
			`const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(file)});
			 db.exec("BEGIN IMMEDIATE"); process.stdout.write("held\\n");
			 process.stdin.once("data", () => { db.exec(${JSON.stringify(sql)}); db.exec("COMMIT"); db.close(); process.exit(0); });`,
		],
		{ stdio: ["pipe", "pipe", "inherit"] },
	);
	await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
	return {
		release: () =>
			new Promise<void>((resolve) => {
				holder.once("exit", () => resolve());
				holder.stdin.write("go\n");
			}),
	};
}

describe("opening an old file another process is migrating", () => {
	it("takes the lock before any backup: busy, it copies nothing and reports a typed busy error at once", async () => {
		const file = versionOne();
		const calls: number[] = [];
		const plan = { version: 2, migrations: [addTable(2, true, calls)] };
		const holder = await holdLock(file);
		const started = performance.now();
		let error: unknown;
		try {
			open(file, plan).close();
		} catch (caught) {
			error = caught;
		}
		const waited = performance.now() - started;
		await holder.release();
		expect(error).toBeInstanceOf(AgentDbMigratingError);
		expect(isBusy(error)).toBe(true);
		expect(waited).toBeLessThan(2_000);
		expect(calls).toEqual([]);
		expect(fs.readdirSync(path.dirname(file)).filter((name) => /\.bak|\.tmp/.test(name))).toEqual([]);
		// Once the lock is free, the next open backs up and migrates.
		open(file, plan).close();
		expect(calls).toEqual([2]);
		expect(versionOf(`${file}.v1.bak`)).toBe(1);
	}, 30_000);

	it("remembers the busy refusal per file until the file changes, then opens the migrated file", async () => {
		const file = path.join(tmp(), "workspaces.db");
		const locations = {
			file,
			mirrorFile: `${file}.transcripts`,
			archiveDir: path.join(tmp(), "archive"),
			privateParent: false,
		};
		openDatabase(locations).close();
		const raw = new DatabaseSync(file);
		raw.exec(`PRAGMA user_version=${SCHEMA_PLAN.version - 1}`);
		raw.close();
		// The other process finishes the migration as it commits.
		const holder = await holdLock(file, `PRAGMA user_version=${SCHEMA_PLAN.version}`);
		try {
			const first = (() => {
				try {
					sharedDatabase(locations);
				} catch (error) {
					return error;
				}
			})();
			expect(first).toBeInstanceOf(AgentDbMigratingError);
			const started = performance.now();
			expect(() => sharedDatabase(locations)).toThrow(first);
			expect(performance.now() - started).toBeLessThan(100);
			await holder.release();
			const agent = sharedDatabase(locations);
			expect(agent.db.isOpen).toBe(true);
			expect(fs.existsSync(`${file}.v${SCHEMA_PLAN.version - 1}.bak`)).toBe(false);
		} finally {
			closeSharedConnections();
		}
	}, 30_000);

	it("retries a busy migration after a lock is released without changing the database", async () => {
		const file = path.join(tmp(), "workspaces.db");
		const locations = {
			file,
			mirrorFile: `${file}.transcripts`,
			archiveDir: path.join(tmp(), "archive"),
			privateParent: false,
		};
		openDatabase(locations).close();
		const raw = new DatabaseSync(file);
		raw.exec(`PRAGMA user_version=${SCHEMA_PLAN.version - 1}`);
		// Keep this connection alive so releasing the peer's unchanged transaction cannot delete the WAL.
		const holder = await holdLock(file);
		let released = false;
		try {
			expect(() => sharedDatabase(locations)).toThrow(AgentDbMigratingError);
			const stamp = dbStamp(file);
			await holder.release();
			released = true;
			expect(dbStamp(file)).toBe(stamp);
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			const agent = sharedDatabase(locations);
			expect(agent.db.isOpen).toBe(true);
			expect(versionOf(file)).toBe(SCHEMA_PLAN.version);
		} finally {
			if (!released) await holder.release();
			raw.close();
			closeSharedConnections();
		}
	}, 30_000);
});

describe("an older Octocode opening a newer agent database", () => {
	const older: SchemaPlan = { version: 1, migrations: [] };

	it("keeps working on a file whose newer versions were additive", () => {
		const file = versionOne();
		open(file, { version: 3, migrations: [addTable(2), addTable(3)] }).close();
		expect(metaValue(file, "schema_readable_from")).toBe("1");
		const agent = open(file, older);
		agent.db.prepare("INSERT INTO meta (key, value) VALUES ('from-old', 'yes')").run();
		agent.close();
		// It writes under the newer file's version and never lowers it.
		expect(versionOf(file)).toBe(3);
		expect(metaValue(file, "from-old")).toBe("yes");
	});

	it("refuses a file past a step that was not additive, names the version needed and keeps the data", () => {
		const file = versionOne();
		open(file, { version: 3, migrations: [addTable(2, false), addTable(3)] }).close();
		expect(metaValue(file, "schema_readable_from")).toBe("2");
		const before = fs.readFileSync(file);
		const refused = () => open(file, older);
		expect(refused).toThrow(AgentDbError);
		expect(refused).toThrow(
			/supports schema version 2 or newer, and this one stops at 1\. Nothing in the file changed/,
		);
		expect(fs.readFileSync(file)).toEqual(before);
		// Version 2 is enough.
		open(file, { version: 2, migrations: [addTable(2, false)] }).close();
		expect(versionOf(file)).toBe(3);
	});

	it("treats a newer file with no recorded floor as needing its own version", () => {
		const file = versionOne();
		const db = new DatabaseSync(file);
		db.exec("PRAGMA user_version=7");
		db.close();
		expect(() => open(file, older)).toThrow(/supports schema version 7 or newer/);
	});

	it("a new file records the floor of its additive history, and none at the first version", () => {
		const fresh = path.join(tmp(), "fresh.db");
		open(fresh, { version: 2, migrations: [addTable(2)] }).close();
		expect(metaValue(fresh, "schema_readable_from")).toBe("1");
		open(fresh, older).close();
		const strict = path.join(tmp(), "strict.db");
		open(strict, { version: 2, migrations: [addTable(2, false)] }).close();
		expect(() => open(strict, older)).toThrow(/supports schema version 2 or newer/);
		const first = path.join(tmp(), "first.db");
		open(first, { version: 1, migrations: [] }).close();
		expect(metaValue(first, "schema_readable_from")).toBeUndefined();
	});

	it("refuses an older file with no path to the plan, before changing it", () => {
		const file = versionOne();
		const before = fs.readFileSync(file);
		expect(() => open(file, { version: 3, migrations: [addTable(3)] })).toThrow(/has no migration from it to 3/);
		expect(fs.readFileSync(file)).toEqual(before);
		expect(fs.existsSync(`${file}.v1.bak`)).toBe(false);
	});
});
