import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../packages/db/src/api.ts";
import { SCHEMA_PLAN } from "../packages/db/src/migrations.ts";
import { migrationBackupLine } from "./db-migrate.mjs";

const SCRIPT = fileURLToPath(new URL("./db-migrate.mjs", import.meta.url));

/** The transcript mirror's tables as a version 9 coordination file holds them. */
const OLD_MIRROR = `
CREATE TABLE session_transcripts (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file TEXT NOT NULL UNIQUE, header TEXT NOT NULL, byte_size INTEGER NOT NULL, mtime TEXT NOT NULL, file_binding TEXT NOT NULL);
CREATE TABLE session_entries (
  session_id TEXT NOT NULL REFERENCES session_transcripts(session_id) ON DELETE CASCADE,
  position INTEGER NOT NULL, entry_id TEXT NOT NULL, parent_id TEXT, type TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(session_id, position));
CREATE TABLE compaction_summaries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), session_id TEXT NOT NULL, entry_id TEXT NOT NULL,
  summary TEXT NOT NULL, committed_at INTEGER, origin_verified INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}', detail_file TEXT, detail_state TEXT NOT NULL DEFAULT 'missing',
  UNIQUE(session_id, entry_id),
  FOREIGN KEY(session_id, workspace_id) REFERENCES sessions(id, workspace_id) ON DELETE CASCADE);`;

/** A version 9 database with one kept workspace and one a test left under the temporary directory, each with a session. */
function versionNine(dir) {
	const file = join(dir, "workspaces.db");
	const locations = {
		file,
		mirrorFile: join(dir, "transcripts.db"),
		archiveDir: join(dir, "archive"),
		privateParent: false,
	};
	openDatabase(locations, { version: 9, migrations: SCHEMA_PLAN.migrations.slice(0, 8) }).close();
	const db = new DatabaseSync(file);
	db.exec(OLD_MIRROR);
	const project = realpathSync(mkdtempSync(join(tmpdir(), "oc-migrate-project-")));
	for (const [ws, root] of [
		["kept", "/r/kept"],
		["test", project],
	]) {
		db.prepare("INSERT INTO workspaces(id,name,root,binding) VALUES (?,?,?,'1:1')").run(ws, ws, root);
		db.prepare("INSERT INTO sessions(id,workspace_id) VALUES (?,?)").run(`s-${ws}`, ws);
		db.prepare(
			"INSERT INTO session_transcripts(session_id,file,header,byte_size,mtime,file_binding) VALUES (?,?,'{}',1,'1','1:1')",
		).run(`s-${ws}`, `/t/${ws}.jsonl`);
		db.prepare(
			"INSERT INTO session_entries(session_id,position,entry_id,type,data) VALUES (?,0,'e','message','{}')",
		).run(`s-${ws}`);
		db.prepare("INSERT INTO compaction_summaries(workspace_id,session_id,entry_id,summary) VALUES (?,?,'c','s')").run(
			ws,
			`s-${ws}`,
		);
	}
	db.close();
	return { file, project };
}

const run = (args, env = process.env) =>
	new Promise((resolve) => {
		execFile(process.execPath, ["--no-warnings", SCRIPT, ...args], { encoding: "utf8", env }, (error, stdout, stderr) =>
			resolve({ code: error ? error.code : 0, stdout, stderr }),
		);
	});

/** Every path under `dir` with its size and modification time: what a run that touches no file leaves unchanged. */
const listing = (dir) =>
	readdirSync(dir, { recursive: true })
		.sort((a, b) => a.localeCompare(b))
		.map((name) => {
			const stat = statSync(join(dir, name));
			return `${name} ${stat.size} ${stat.mtimeMs}`;
		});

const query = (file, sql) => {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return db
			.prepare(sql)
			.all()
			.map((row) => ({ ...row }));
	} finally {
		db.close();
	}
};

test("moves the transcript mirror, verifies it and removes the workspaces tests left in the temporary directory", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "oc-migrate-"));
	const { file, project } = versionNine(dir);
	t.after(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(project, { recursive: true, force: true });
	});
	const result = await run(["--db", file, "--clean-test-rows"]);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /verified: every session's rows and checksums match/);
	assert.match(result.stdout, /removed 1 temporary workspaces/);
	assert.ok(existsSync(`${file}.v9.bak`));
	assert.deepEqual(query(file, "PRAGMA user_version"), [{ user_version: 10 }]);
	assert.deepEqual(query(file, "SELECT id FROM workspaces"), [{ id: "kept" }]);
	assert.deepEqual(query(file, "SELECT id FROM sessions"), [{ id: "s-kept" }]);
	assert.deepEqual(query(join(dir, "transcripts.db"), "SELECT session_id FROM session_transcripts"), [
		{ session_id: "s-kept" },
	]);
	assert.deepEqual(query(join(dir, "transcripts.db"), "SELECT session_id FROM compaction_summaries"), [
		{ session_id: "s-kept" },
	]);
});

test("refuses while another process holds the database open, and names it", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "oc-migrate-"));
	const { file, project } = versionNine(dir);
	const holder = spawn(
		process.execPath,
		[
			"-e",
			`const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(${JSON.stringify(file)});
			 db.prepare("SELECT 1").get(); process.stdout.write("open\\n"); setInterval(() => {}, 1000);`,
		],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	t.after(() => {
		holder.kill();
		rmSync(dir, { recursive: true, force: true });
		rmSync(project, { recursive: true, force: true });
	});
	await new Promise((resolve) => holder.stdout.once("data", resolve));
	const result = await run(["--db", file]);
	assert.equal(result.code, 2);
	assert.match(result.stderr, new RegExp(`Refusing: .* ${holder.pid}`));
	assert.deepEqual(query(file, "PRAGMA user_version"), [{ user_version: 9 }]);
});

test("--help and -h print the usage and exit 0, and an unknown flag prints it and exits 2, touching no file", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "oc-migrate-"));
	const { file, project } = versionNine(dir);
	// The home the script falls back to without --db: empty, and it must stay so.
	const home = mkdtempSync(join(tmpdir(), "oc-migrate-home-"));
	t.after(() => {
		for (const each of [dir, project, home]) rmSync(each, { recursive: true, force: true });
	});
	const env = { ...process.env, HOME: home, OCTOCODE_HOME: join(home, "octocode"), OCTOCODE_AGENT_DB: "" };
	const before = listing(dir);
	for (const args of [["--help"], ["-h"], ["--db", file, "--help"]]) {
		const result = await run(args, env);
		assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
		assert.match(result.stdout, /^Usage: node scripts\/db-migrate\.mjs/);
		assert.equal(result.stderr, "");
	}
	for (const args of [["--bogus"], ["--db", file, "--clean-test-rowz"], ["--db"], ["stray"]]) {
		const result = await run(args, env);
		assert.equal(result.code, 2, `${args.join(" ")}: ${result.stdout}`);
		assert.match(result.stderr, /Usage: node scripts\/db-migrate\.mjs/);
		assert.equal(result.stdout, "");
	}
	assert.deepEqual(listing(dir), before);
	assert.deepEqual(readdirSync(home), []);
	assert.deepEqual(query(file, "PRAGMA user_version"), [{ user_version: 9 }]);
});

test("reports a file another process migrated first as already migrated, instead of failing on the missing backup", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "oc-migrate-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "workspaces.db");
	assert.match(migrationBackupLine(file, 9), /^already migrated: another process migrated .* first/);
	writeFileSync(`${file}.v9.bak`, "x".repeat(2 * 1024 * 1024));
	assert.equal(migrationBackupLine(file, 9), `migration backup: ${file}.v9.bak (2.0 MB)`);
});
