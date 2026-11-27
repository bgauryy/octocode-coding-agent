import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type AgentDb, openDatabase } from "../src/db.ts";
import { baseVersion, COORDINATION_FILE, type FileKind } from "../src/schema.ts";
import { loadSqlite } from "../src/sqlite.ts";
import { tmp } from "./helpers.ts";

const { DatabaseSync } = loadSqlite();

const open = (file: string, kind: FileKind = COORDINATION_FILE): AgentDb =>
	openDatabase(
		{
			file,
			mirrorFile: `${file}.transcripts`,
			archiveDir: path.join(path.dirname(file), "archive"),
			privateParent: false,
		},
		kind,
	);

const query = <T>(file: string, sql: string): T[] => {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return db.prepare(sql).all() as T[];
	} finally {
		db.close();
	}
};
const versionOf = (file: string) => query<{ user_version: number }>(file, "PRAGMA user_version")[0]?.user_version;
const evidenceOf = (file: string) => query<{ evidence: string }>(file, "SELECT evidence FROM backlog")[0]?.evidence;
const linksOf = (file: string) =>
	query<{ relation: string; target: string }>(file, "SELECT relation, target FROM backlog_links ORDER BY rowid").map(
		(link) => [link.relation, JSON.parse(link.target)],
	);

const EVIDENCE = "docs/a.md\nhttps://example.com/a\nsaw it fail\nsrc/a.ts:12 — shows it";

/** A closed version-10 file: one item whose evidence text holds two references and an existing link. */
function version10(): string {
	const file = path.join(tmp(), "workspaces.db");
	const agent = open(file);
	agent.db.exec(`INSERT INTO workspaces (id, name, root, binding) VALUES ('repo', 'demo', '/demo', 'b');
		INSERT INTO backlog (workspace_id, seq, title, state, created_by, created_at, updated_at)
			VALUES ('repo', 1, 'old row', 'todo', 'user', 1, 1);`);
	agent.db.prepare("UPDATE backlog SET evidence = ?").run(EVIDENCE);
	agent.db
		.prepare("INSERT INTO backlog_links VALUES (1, 'output', ?)")
		.run(JSON.stringify({ resource: "external", url: "https://o.example" }));
	agent.db.exec("PRAGMA user_version=10");
	agent.close();
	return file;
}

describe("upgrading an agent database", () => {
	it("backs up a version-10 file and turns its path and URL evidence text into links", () => {
		const file = version10();
		open(file).close();
		expect(versionOf(file)).toBe(baseVersion(COORDINATION_FILE));
		expect(evidenceOf(file)).toBe("saw it fail\nsrc/a.ts:12 — shows it");
		expect(linksOf(file)).toEqual([
			["output", { resource: "external", url: "https://o.example" }],
			["evidence", { resource: "files", repositoryKey: "repo", path: "docs/a.md" }],
			["evidence", { resource: "external", url: "https://example.com/a" }],
		]);
		const backup = `${file}.v10.bak`;
		expect(versionOf(backup)).toBe(10);
		expect(evidenceOf(backup)).toBe(EVIDENCE);
		expect(fs.statSync(backup).mode & 0o077).toBe(0);
		// Opening the upgraded file again changes nothing and copies nothing.
		const stamp = fs.statSync(backup).mtimeMs;
		open(file).close();
		expect(evidenceOf(file)).toBe("saw it fail\nsrc/a.ts:12 — shows it");
		expect(fs.statSync(backup).mtimeMs).toBe(stamp);
	});

	it("opens a current file without a backup", () => {
		const file = path.join(tmp(), "workspaces.db");
		open(file).close();
		open(file).close();
		expect(versionOf(file)).toBe(baseVersion(COORDINATION_FILE));
		expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".bak"))).toEqual([]);
	});

	it("refuses a newer file without a backup or change", () => {
		const file = version10();
		const raw = new DatabaseSync(file);
		raw.exec(`DROP TABLE schema_meta; PRAGMA user_version=${COORDINATION_FILE.version + 1}`);
		raw.close();
		const before = fs.readFileSync(file);
		expect(() => open(file)).toThrow(/newer than this Octocode's/);
		expect(fs.readFileSync(file)).toEqual(before);
		expect(fs.existsSync(`${file}.v10.bak`)).toBe(false);
	});

	it("rolls a failing step back and leaves the file at version 10", () => {
		const file = version10();
		const failing: FileKind = {
			...COORDINATION_FILE,
			migrations: (COORDINATION_FILE.migrations ?? []).map((step) => ({
				...step,
				run: (db) => {
					step.run(db);
					throw new Error("step failed");
				},
			})),
		};
		expect(() => open(file, failing)).toThrow("step failed");
		expect(versionOf(file)).toBe(10);
		expect(evidenceOf(file)).toBe(EVIDENCE);
		expect(linksOf(file)).toHaveLength(1);
		// The real step then upgrades the same file.
		open(file).close();
		expect(versionOf(file)).toBe(baseVersion(COORDINATION_FILE));
		expect(linksOf(file)).toHaveLength(3);
	});
});
