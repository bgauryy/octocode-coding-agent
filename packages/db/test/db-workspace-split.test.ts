import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.ts";
import { AgentDbError, COORDINATION_FILE, type FileKind } from "../src/schema.ts";
import { needsSplit, splitBackupPath, splitWorkspaces, WORKSPACE_TABLES } from "../src/schema-split.ts";
import * as workspaces from "../src/queries/workspaces.ts";
import { tmp } from "./helpers.ts";
import {
	count,
	counts,
	dirOf,
	hash,
	minReaderOf,
	openMachine,
	rows,
	version11,
	where,
	DatabaseSync,
} from "./split-fixture.ts";

/** A build at schema 11, from before workspace files. */
const older: FileKind = { ...COORDINATION_FILE, version: 11, minReader: 10, migrations: [], optionalStep: undefined };

describe("splitting the machine file into workspace files", () => {
	it("moves each repository's rows into its own file, keeping ids, and leaves machine-wide rows", () => {
		const file = version11();
		const before = counts(file);
		const ids = rows<{ id: number; workspace_id: string }>(
			file,
			"SELECT id, workspace_id FROM backlog_audits ORDER BY id",
		);
		openMachine(file).close();

		const repo = path.join(dirOf(file), "main.db");
		const solo = path.join(dirOf(file), "solo.db");
		expect(fs.readdirSync(dirOf(file)).sort()).toEqual(["main.db", "solo.db"]);
		// The linked worktree's rows share the main checkout's file, on its own board.
		expect(rows(repo, "SELECT workspace_id, seq FROM backlog ORDER BY workspace_id")).toEqual([
			{ workspace_id: "main", seq: 1 },
			{ workspace_id: "wt", seq: 1 },
		]);
		expect(rows(solo, "SELECT workspace_id FROM backlog")).toEqual([{ workspace_id: "solo" }]);
		for (const table of WORKSPACE_TABLES) {
			expect(count(repo, table) + count(solo, table), table).toBe(before[table]);
			expect(count(file, table), table).toBe(0);
		}
		// Audits moved as they were: same ids, none made again by the copy.
		expect(
			[
				...rows<{ id: number; workspace_id: string }>(repo, "SELECT id, workspace_id FROM backlog_audits"),
				...rows<{ id: number; workspace_id: string }>(solo, "SELECT id, workspace_id FROM backlog_audits"),
			].sort((a, b) => a.id - b.id),
		).toEqual(ids);
		expect(count(file, "memories")).toBe(2);
		expect(count(file, "sessions")).toBe(3);
		expect(count(file, "workspaces")).toBe(3);
		expect(rows(file, "SELECT id, db_key FROM workspaces ORDER BY id")).toEqual([
			{ id: "main", db_key: "main" },
			{ id: "solo", db_key: "solo" },
			{ id: "wt", db_key: "main" },
		]);
		// The backups hold every row as it was before the upgrade and before the split.
		expect(counts(`${file}.v11.bak`)).toEqual(before);
		expect(counts(splitBackupPath(file))).toEqual(before);
		expect(minReaderOf(file)).toBe(13);
	});

	it("continues new ids above the machine file's, and a second open changes nothing", () => {
		const file = version11();
		const top = rows<{ seq: number }>(file, "SELECT seq FROM sqlite_sequence WHERE name = 'backlog_audits'")[0].seq;
		openMachine(file).close();
		const repo = path.join(dirOf(file), "main.db");
		const workspace = openDatabase(where(repo, { workspace: "main" }));
		workspace.db.exec(
			"INSERT INTO backlog_notes (item, at, author, text) SELECT id, 9, 'user', 'later' FROM backlog LIMIT 1",
		);
		const newest = rows<{ id: number }>(repo, "SELECT max(id) AS id FROM backlog_audits")[0].id;
		workspace.close();
		expect(newest).toBeGreaterThan(top);
		const stamps = [hash(file), hash(repo)];
		openMachine(file).close();
		expect([hash(file), hash(repo)]).toEqual(stamps);
	});

	it("leaves the machine file whole and no workspace file when a split is interrupted, and splits at the next open", () => {
		const file = version11();
		const before = counts(file);
		const machine = openDatabase(where(file));
		expect(needsSplit(machine.db)).toBe(true);
		let opened = 0;
		expect(() =>
			splitWorkspaces(machine.db, {
				file,
				workspaceDir: dirOf(file),
				transaction: machine.transaction,
				running: () => false,
				open: (target, key) => {
					// The first group is copied; the process dies while copying the second.
					if (++opened > 1) throw new Error("interrupted");
					return openDatabase(where(target, { workspace: key }));
				},
			}),
		).toThrow("interrupted");
		expect(counts(file)).toEqual(before);
		expect(needsSplit(machine.db)).toBe(true);
		machine.close();
		expect(fs.readdirSync(dirOf(file))).toEqual([]);

		openMachine(file).close();
		const after = counts(path.join(dirOf(file), "main.db"));
		const solo = counts(path.join(dirOf(file), "solo.db"));
		for (const table of WORKSPACE_TABLES) expect(after[table] + solo[table], table).toBe(before[table]);
	});

	it("is refused by a build older than the split, and a workspace file is refused for another key", () => {
		const file = version11();
		openMachine(file).close();
		expect(() => openDatabase(where(file), older)).toThrow(/only schema 13 or newer can read it/);
		const repo = path.join(dirOf(file), "main.db");
		const stamp = hash(repo);
		expect(() => openDatabase(where(repo, { workspace: "solo" }))).toThrow(AgentDbError);
		expect(() => openDatabase(where(repo))).toThrow(/is not an Octocode agent database/);
		expect(hash(repo)).toBe(stamp);
	});

	it("gives a repository's checkouts one key and a folder outside Git its own", () => {
		const file = path.join(tmp(), "workspaces.db");
		const agent = openDatabase(where(file));
		try {
			agent.db.exec(`INSERT INTO workspaces (id, name, root, binding, git_common_dir, linked_worktree) VALUES
				('wt', 'wt', '/wt', 'b1', '/r/.git', 1), ('main', 'r', '/r', 'b2', '/r/.git', 0), ('solo', 'b', '/b', 'b3', NULL, NULL)`);
			expect(workspaces.claimDbKey(agent.db, "wt", "main")).toBe("main");
			// The main checkout registered later takes the key its worktree claimed, whatever it proposes.
			expect(workspaces.claimDbKey(agent.db, "main", "other")).toBe("main");
			expect(workspaces.claimDbKey(agent.db, "solo", "solo")).toBe("solo");
			expect(workspaces.claimDbKey(agent.db, "solo", "changed")).toBe("solo");
			expect(workspaces.claimDbKey(agent.db, "missing", "missing")).toBeUndefined();
		} finally {
			agent.close();
		}
	});

	it("splits a file stamped min_reader 12 by an earlier build when it has no split marker", () => {
		const file = version11();
		const before = counts(file);
		// As the real file was left: upgraded to 12, stamped min_reader 12, and marked pending, with every row still in it.
		openDatabase(where(file)).close();
		const stamped = new DatabaseSync(file);
		stamped.exec(
			"UPDATE schema_meta SET min_reader = 12; INSERT INTO meta (key, value) VALUES ('workspace_split', 'pending')",
		);
		stamped.close();
		openMachine(file).close();
		const repo = counts(path.join(dirOf(file), "main.db"));
		const solo = counts(path.join(dirOf(file), "solo.db"));
		for (const table of WORKSPACE_TABLES) {
			expect(repo[table] + solo[table], table).toBe(before[table]);
			expect(count(file, table), table).toBe(0);
		}
		expect(rows(file, "SELECT value FROM meta WHERE key = 'workspace_split'")).toEqual([{ value: "done" }]);
	});

	it("creates no workspace file for a fresh machine file", () => {
		const file = path.join(tmp(), "workspaces.db");
		openMachine(file).close();
		expect(fs.existsSync(dirOf(file))).toBe(false);
		expect(minReaderOf(file)).toBe(13);
	});

	it("leaves an upgraded file readable by older builds while no host names the workspace folder", () => {
		const file = version11();
		const before = counts(file);
		openDatabase(where(file)).close();
		expect(minReaderOf(file)).toBe(10);
		expect(counts(file)).toEqual(before);
		expect(fs.existsSync(dirOf(file))).toBe(false);
		openDatabase(where(file), older).close();
	});
});
