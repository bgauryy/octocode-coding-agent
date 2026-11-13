#!/usr/bin/env node
/**
 * Runs the agent database's migration on demand, with a report: the move of the transcript mirror out of
 * `workspaces.db` into `transcripts.db` (schema version 10), and, with `--clean-test-rows`, the removal of workspaces
 * that tests left under the OS temporary directory (with their sessions and every row that depends on them).
 *
 *   node scripts/db-migrate.mjs [--db <workspaces.db>] [--clean-test-rows]
 *
 * `--help` prints the usage; an unknown flag prints it and exits 2. Neither opens or creates any file.
 *
 * It refuses while any other process holds the database open (it lists their pids): old Octocode processes would fail on
 * the moved tables. The migration saves `<db>.v<version>.bak` (the coordination data) before it changes anything; the
 * cleanup saves `<db>.pre-clean-<time>.bak` first. Prints sizes, row counts and per-session checksums before and after.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	fileReport,
	maintenance,
	mirrorInventory,
	openDatabase,
	openReadOnlyDb,
	purge,
	workspaces,
} from "../packages/db/src/api.ts";
import { agentDbPath, globalPaths, transcriptDbPath } from "../packages/coding-agent/src/storage/state-paths.ts";

const MB = 1024 * 1024;
const size = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

/** Pids other than this one that hold any of the database's files open (`lsof`); empty when none does. */
function holders(file) {
	const files = [file, `${file}-wal`, `${file}-shm`].filter((each) => fs.existsSync(each));
	let out = "";
	try {
		out = execFileSync("lsof", ["-t", "--", ...files], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch (error) {
		// lsof exits 1 when no process has the files open.
		if (error.status === 1) return [];
		throw new Error(`lsof failed (${error.message}); close every Octocode process and check by hand`, {
			cause: error,
		});
	}
	return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))].filter((pid) => pid !== process.pid);
}

const inventoryOf = (file) => {
	if (!fs.existsSync(file)) return undefined;
	const db = openReadOnlyDb(file);
	try {
		return mirrorInventory(db);
	} finally {
		db.close();
	}
};

function printFile(label, report) {
	if (!report) return console.log(`${label}: (none)`);
	const rows = Object.entries(report.tables)
		.filter(([, n]) => n > 0)
		.map(([name, n]) => `${name}=${n}`)
		.join(" ");
	console.log(
		`${label}: ${report.file}\n  version ${report.version}, ${size(report.bytes)} + WAL ${size(report.walBytes)}`,
	);
	console.log(`  rows: ${rows || "(none)"}`);
}

function printInventory(label, inventory) {
	if (!inventory) return console.log(`${label}: (no transcript mirror)`);
	console.log(
		`${label}: ${inventory.transcripts} transcripts, ${inventory.entries} entries, ${inventory.summaries} summaries, ${inventory.sessions.size} sessions, sha256 ${inventory.sha256}`,
	);
}

/** The workspaces whose folder lies inside the OS temporary directory: what tests left behind. */
function temporaryWorkspaces(db) {
	const roots = [...new Set([os.tmpdir(), fs.realpathSync(os.tmpdir())])].map((root) => path.resolve(root) + path.sep);
	return workspaces.list(db).filter((workspace) => roots.some((root) => workspace.root.startsWith(root)));
}

/**
 * What the run says of the backup the migration took. None is there when another process migrated the file between this
 * run's first look and its open (the migration then saves nothing): the file is already migrated.
 */
export function migrationBackupLine(file, version) {
	const backup = `${file}.v${version}.bak`;
	const saved = fs.statSync(backup, { throwIfNoEntry: false });
	return saved
		? `migration backup: ${backup} (${size(saved.size)})`
		: `already migrated: another process migrated ${file} first; this run saved no backup`;
}

const USAGE = `Usage: node scripts/db-migrate.mjs [--db <workspaces.db>] [--clean-test-rows]

Migrates the agent database (the real home's unless --db names one) and verifies the transcript mirror.
  --db <file>         the coordination file to migrate
  --clean-test-rows   also remove the workspaces tests left under the OS temporary directory
  -h, --help          print this and exit`;

/** The options, or the exit code when the arguments ask for the usage (0) or are wrong (2); checked before any file. */
function options(argv) {
	try {
		const { values } = parseArgs({
			args: argv,
			options: {
				db: { type: "string" },
				"clean-test-rows": { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
			strict: true,
			allowPositionals: false,
		});
		if (values.help) {
			console.log(USAGE);
			return 0;
		}
		return values;
	} catch (error) {
		console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
		return 2;
	}
}

function main(argv) {
	const parsed = options(argv);
	if (typeof parsed === "number") return parsed;
	const file = path.resolve(parsed.db ?? agentDbPath());
	const mirrorFile = transcriptDbPath(file);
	if (!fs.existsSync(file)) throw new Error(`No agent database at ${file}`);
	const busy = holders(file);
	if (busy.length > 0) {
		console.error(`Refusing: these processes hold ${file} open; close them first: ${busy.join(", ")}`);
		return 2;
	}
	const before = fileReport(file);
	printFile("before, coordination", before);
	printFile("before, mirror", fileReport(mirrorFile));
	// Before version 10 the mirror tables sit in the coordination file.
	const sourceInventory = inventoryOf(before.version < 10 ? file : mirrorFile);
	printInventory("before, transcript mirror", sourceInventory);

	// The real home's folders for the configured database; a `--db` file keeps everything beside it.
	const home = globalPaths();
	const locations = {
		file,
		mirrorFile,
		archiveDir: parsed.db ? path.join(path.dirname(file), "archive") : path.join(home.home, "archive"),
		privateParent: path.dirname(file) === home.agentState,
	};
	let last = 0;
	const agent = openDatabase(locations, undefined, {
		progress: (done, total) => {
			if (done === total || Date.now() - last > 1000) {
				last = Date.now();
				console.log(`  moved ${done}/${total} sessions`);
			}
		},
	});
	try {
		if (before.version < 10) console.log(migrationBackupLine(file, before.version));
		const moved = inventoryOf(mirrorFile);
		printInventory("after, transcript mirror", moved);
		if (sourceInventory && moved && sourceInventory.sha256 !== moved.sha256) {
			console.error("MISMATCH: the transcript mirror differs from its source");
			return 1;
		}
		console.log("verified: every session's rows and checksums match");
		if (parsed["clean-test-rows"]) {
			const stale = temporaryWorkspaces(agent.db);
			const saved = `${file}.pre-clean-${new Date().toISOString().replaceAll(":", "-")}.bak`;
			maintenance.snapshot(agent.db, saved);
			console.log(`cleanup backup: ${saved}`);
			const removed = {};
			for (const workspace of stale)
				for (const [table, n] of Object.entries(purge.workspace(agent.db, agent.mirror.db, workspace.id)))
					removed[table] = (removed[table] ?? 0) + n;
			const rows = Object.entries(removed)
				.filter(([, n]) => n > 0)
				.map(([table, n]) => `${table}=${n}`);
			console.log(`removed ${stale.length} temporary workspaces: ${rows.join(" ") || "no rows"}`);
		}
		for (const db of [agent.db, agent.mirror.db]) {
			const result = maintenance.vacuum(db);
			if (result.busy) console.log("  vacuum skipped: another connection is open");
		}
	} finally {
		agent.close();
	}
	printFile("after, coordination", fileReport(file));
	printFile("after, mirror", fileReport(mirrorFile));
	printInventory("after cleanup, transcript mirror", inventoryOf(mirrorFile));
	return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
