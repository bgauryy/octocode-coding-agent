import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.ts";
import { AgentDbError, COORDINATION_FILE, type FileKind } from "../src/schema.ts";
import { needsSplit, SPLIT_TOKEN, splitBackupPath, WORKSPACE_TABLES } from "../src/schema-split.ts";
import {
	count,
	counts,
	dirOf,
	hash,
	minReaderOf,
	openMachine,
	restore,
	rows,
	version12,
	versionOf,
	where,
	write,
} from "./split-fixture.ts";

/** A build from before the split: schema 12, which knows no step past it. */
const unsplitBuild: FileKind = { ...COORDINATION_FILE, version: 12, optionalStep: undefined };

const backlog = (file: string) =>
	rows<{ workspace_id: string; seq: number; title: string }>(
		file,
		"SELECT workspace_id, seq, title FROM backlog ORDER BY workspace_id, seq",
	);
const item = (ws: string, seq: number, title: string) =>
	`INSERT INTO backlog (workspace_id, seq, title, state, created_by, created_at, updated_at)
		VALUES ('${ws}', ${seq}, '${title}', 'todo', 'user', 5, 5)`;

/** A version-12 file split once, then put back as it was before (a crash before the commit, or a rollback). */
function splitThenRestored(): { file: string; repo: string } {
	const file = version12();
	const copy = `${file}.copy`;
	fs.copyFileSync(file, copy);
	openMachine(file).close();
	restore(file, copy);
	return { file, repo: path.join(dirOf(file), "main.db") };
}

describe("the split cannot lose rows", () => {
	it("leaves a version-12 file at 12 when no split runs", () => {
		const file = version12();
		expect([versionOf(file), minReaderOf(file)]).toEqual([12, 10]);
		// Reopened with workspace files off, and by a writer that knows the folder but never splits.
		openDatabase(where(file)).close();
		openDatabase(where(file, { workspaceDir: dirOf(file) })).close();
		expect([versionOf(file), minReaderOf(file)]).toEqual([12, 10]);
		openDatabase(where(file), unsplitBuild).close();
		expect(fs.existsSync(dirOf(file))).toBe(false);
	});

	it("locks every reader without workspace files out of a split file, loudly (repro A)", () => {
		const file = version12();
		write(file, "INSERT INTO meta (key, value) VALUES ('backlog_seq:main', '50'), ('backlog_task_seq:main', '7')");
		openMachine(file).close();
		expect([versionOf(file), minReaderOf(file)]).toEqual([13, 13]);
		const stamp = hash(file);
		// This build with workspace files off, and a build from before the split.
		expect(() => openDatabase(where(file))).toThrow(AgentDbError);
		expect(() => openDatabase(where(file))).toThrow(/split into workspace files/);
		expect(() => openDatabase(where(file), unsplitBuild)).toThrow(/only schema 13 or newer can read it/);
		expect(hash(file)).toBe(stamp);
		// The counters moved: the machine file keeps none that a stale process could number from.
		expect(rows(file, "SELECT key FROM meta WHERE key LIKE 'backlog_%'")).toEqual([]);
		expect(rows(path.join(dirOf(file), "main.db"), "SELECT value FROM meta WHERE key = 'backlog_seq:main'")).toEqual([
			{ value: "50" },
		]);
		// A writer thread of a host with workspace files on reads it.
		openDatabase(where(file, { workspaceDir: dirOf(file) })).close();
	});

	it("recopies over a stale workspace file whose row counts differ, keeping it aside (repro B)", () => {
		const { file, repo } = splitThenRestored();
		write(file, item("main", 2, "written between crash and resume"));
		openMachine(file).close();
		expect(backlog(repo)).toEqual([
			{ workspace_id: "main", seq: 1, title: "item of main" },
			{ workspace_id: "main", seq: 2, title: "written between crash and resume" },
			{ workspace_id: "wt", seq: 1, title: "item of wt" },
		]);
		for (const table of WORKSPACE_TABLES) expect(count(file, table), table).toBe(0);
		// The file found in place is moved aside whole, never deleted.
		expect(count(`${repo}.replaced-1`, "backlog")).toBe(2);
		openMachine(file).close();
	});

	it("recopies over a stale workspace file whose row counts match (repro C)", () => {
		const { file, repo } = splitThenRestored();
		write(file, "UPDATE timers SET note = 'edited after restore'");
		openMachine(file).close();
		expect(rows(repo, "SELECT DISTINCT note FROM timers")).toEqual([{ note: "edited after restore" }]);
		expect(count(file, "timers")).toBe(0);
	});

	it("stamps every workspace file with the split's token", () => {
		const file = version12();
		openMachine(file).close();
		const [token] = rows<{ value: string }>(file, `SELECT value FROM meta WHERE key = '${SPLIT_TOKEN}'`);
		expect(token.value).toMatch(/\S{16}/);
		for (const name of ["main.db", "solo.db"])
			expect(rows(path.join(dirOf(file), name), `SELECT value FROM meta WHERE key = '${SPLIT_TOKEN}'`)).toEqual([
				token,
			]);
	});

	it("refuses to split while another session's recorded process runs, naming it", () => {
		const file = version12();
		write(file, "UPDATE sessions SET pid = 4242, pid_started = '100' WHERE id = 's-wt'");
		const before = counts(file);
		const running = (pid: number, started: string | null) => pid === 4242 && started === "100";
		expect(() => openMachine(file, running)).toThrow(/s-wt \(pid 4242\)/);
		expect(counts(file)).toEqual(before);
		expect(versionOf(file)).toBe(12);
		expect(fs.existsSync(dirOf(file))).toBe(false);
		expect(fs.existsSync(splitBackupPath(file))).toBe(false);
		// Once it ends, or when the only live process is this one, the split runs.
		write(file, `UPDATE sessions SET pid = ${process.pid} WHERE id = 's-wt'`);
		openMachine(file, () => true).close();
		expect(versionOf(file)).toBe(13);
	});

	it("puts the split off while another session's process runs, opening the un-split layout, when the host asks", () => {
		const file = version12();
		write(file, "UPDATE sessions SET pid = 4242, pid_started = '100' WHERE id = 's-wt'");
		const before = counts(file);
		const reasons: string[] = [];
		const running = (pid: number, started: string | null) => pid === 4242 && started === "100";
		const db = openDatabase(
			where(file, { workspaceDir: dirOf(file), split: { running, deferred: (reason) => reasons.push(reason) } }),
		);
		expect(db.workspaceDir).toBeUndefined();
		db.close();
		expect(reasons).toEqual([expect.stringMatching(/s-wt \(pid 4242\)/)]);
		expect(counts(file)).toEqual(before);
		expect(versionOf(file)).toBe(12);
		expect(needsSplit(new DatabaseSync(file, { readOnly: true }))).toBe(true);
		expect(fs.existsSync(dirOf(file))).toBe(false);
	});

	it("takes a fresh backup at every split, keeping the previous one", () => {
		const { file } = splitThenRestored();
		const first = hash(splitBackupPath(file));
		// The documented rollback: the workspace files go, the backup stays where it was.
		for (const name of fs.readdirSync(dirOf(file))) fs.rmSync(path.join(dirOf(file), name));
		write(file, item("main", 2, "after the rollback"));
		openMachine(file).close();
		expect(hash(`${splitBackupPath(file)}.1`)).toBe(first);
		expect(backlog(splitBackupPath(file))).toContainEqual({
			workspace_id: "main",
			seq: 2,
			title: "after the rollback",
		});
	});

	it("removes the temporary files a killed split left", () => {
		const file = version12();
		fs.mkdirSync(dirOf(file));
		const left = [path.join(dirOf(file), "main.db.99999.tmp"), `${splitBackupPath(file)}.99999.tmp`];
		for (const each of left) fs.writeFileSync(each, "partial");
		openMachine(file).close();
		for (const each of left) expect(fs.existsSync(each), each).toBe(false);
		const reader = openDatabase(where(file, { workspaceDir: dirOf(file) }));
		expect(needsSplit(reader.db)).toBe(false);
		reader.close();
	});
});
