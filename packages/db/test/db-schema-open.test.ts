import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type AgentDb, openDatabase } from "../src/db.ts";
import { AgentDbError, COORDINATION_FILE, type FileKind } from "../src/schema.ts";
import { loadSqlite } from "../src/sqlite.ts";
import { tmp } from "./helpers.ts";

const { DatabaseSync } = loadSqlite();

const open = (file: string, kind?: FileKind): AgentDb =>
	openDatabase(
		{
			file,
			mirrorFile: `${file}.transcripts`,
			archiveDir: path.join(path.dirname(file), "archive"),
			privateParent: false,
		},
		kind,
	);

const read = <T>(file: string, sql: string): T | undefined => {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return db.prepare(sql).get() as T | undefined;
	} finally {
		db.close();
	}
};
const versionOf = (file: string) => read<{ user_version: number }>(file, "PRAGMA user_version")?.user_version;
const kept = (file: string) => read<{ value: string }>(file, "SELECT value FROM meta WHERE key = 'keep'")?.value;

/** A current database with a row that must survive, closed. */
function current(): string {
	const file = path.join(tmp(), "workspaces.db");
	const agent = open(file);
	agent.db.prepare("INSERT INTO meta (key, value) VALUES ('keep', 'me')").run();
	agent.close();
	return file;
}

describe("opening an agent database", () => {
	it("creates the schema in an empty file and uses a current file as it is", () => {
		const file = current();
		expect(versionOf(file)).toBe(COORDINATION_FILE.version);
		open(file).close();
		expect(kept(file)).toBe("me");
		expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".retired"))).toEqual([]);
	});

	it("sets a file at an older version aside, with its data, and creates a new one: there are no upgrade steps", () => {
		const file = current();
		const newer: FileKind = { ...COORDINATION_FILE, version: COORDINATION_FILE.version + 1 };
		open(file, newer).close();
		expect(versionOf(file)).toBe(newer.version);
		expect(kept(file)).toBeUndefined();
		// Nothing was deleted: the old file is whole under its retired name.
		const retired = `${file}.v${COORDINATION_FILE.version}.retired`;
		expect(versionOf(retired)).toBe(COORDINATION_FILE.version);
		expect(kept(retired)).toBe("me");
	});

	it("refuses a file at a newer version and changes nothing in it", () => {
		const file = current();
		const raw = new DatabaseSync(file);
		raw.exec(`PRAGMA user_version=${COORDINATION_FILE.version + 1}`);
		raw.close();
		const before = fs.readFileSync(file);
		expect(() => open(file)).toThrow(AgentDbError);
		expect(() => open(file)).toThrow(/newer than this Octocode's/);
		expect(fs.readFileSync(file)).toEqual(before);
		expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".retired"))).toEqual([]);
	});

	it("refuses a file that is not one of Octocode's", () => {
		const file = path.join(tmp(), "foreign.db");
		const raw = new DatabaseSync(file);
		raw.exec("CREATE TABLE theirs (x)");
		raw.close();
		expect(() => open(file)).toThrow(/is not an Octocode agent database/);
	});
});

describe("a schema change that retires the agent database", () => {
	const older: FileKind = { ...COORDINATION_FILE, version: COORDINATION_FILE.version - 1 };
	const count = (agent: AgentDb, table: string) =>
		(agent.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

	/** A file at the previous version holding one of each kind of row people write, closed. */
	function previous(kind: FileKind = older): string {
		const file = path.join(tmp(), "workspaces.db");
		const agent = open(file, kind);
		const now = Date.now();
		agent.db.exec(`
			INSERT INTO workspaces (id, name, root, binding) VALUES ('w1', 'repo', '/repo', '1:2');
			INSERT INTO meta (key, value) VALUES ('keep', 'me');`);
		agent.db
			.prepare(
				"INSERT INTO memories (scope, workspace_id, kind, title, body, author, created_at, updated_at) VALUES ('workspace', 'w1', 'preference', 'Answer in tables', 'kept across versions', 'user', ?, ?)",
			)
			.run(now, now);
		agent.db
			.prepare(
				"INSERT INTO backlog (workspace_id, seq, title, state, created_by, created_at, updated_at) VALUES ('w1', 1, 'Ship the carry step', 'todo', 'user', ?, ?)",
			)
			.run(now, now);
		agent.db
			.prepare("INSERT INTO backlog_notes (item, at, author, text) VALUES (1, ?, 'user', 'why it matters')")
			.run(now);
		agent.db
			.prepare(
				"INSERT INTO trusted_folders (path, dev, ino, scope, source, surface, decided_by, decided_at) VALUES ('/repo', '1', '2', 'folder', 'prompt', 'tui', 'user', ?)",
			)
			.run(now);
		agent.close();
		return file;
	}

	it("carries memories, the backlog with its notes and history, and trust into the new file, as they were", () => {
		const file = previous();
		const before = open(file, older);
		const audits = count(before, "backlog_audits");
		const comments = count(before, "backlog_comments");
		before.close();

		const agent = open(file);
		try {
			expect(versionOf(file)).toBe(COORDINATION_FILE.version);
			const memory = agent.db.prepare("SELECT id, title, body, workspace_id FROM memories").get();
			expect(memory).toEqual({ id: 1, title: "Answer in tables", body: "kept across versions", workspace_id: "w1" });
			expect(agent.db.prepare("SELECT seq, title, state FROM backlog").get()).toEqual({
				seq: 1,
				title: "Ship the carry step",
				state: "todo",
			});
			// Rows arrive as they were: the new file's triggers add no audit rows and do not double notes into comments.
			expect(count(agent, "backlog_audits")).toBe(audits);
			expect(count(agent, "backlog_comments")).toBe(comments);
			expect(count(agent, "trusted_folders")).toBe(1);
			// The memory search index holds the carried rows, and the triggers work again for new ones.
			if (agent.fts)
				expect(agent.db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'tables'").all()).toHaveLength(
					1,
				);
			agent.db.prepare("INSERT INTO backlog_notes (item, at, author, text) VALUES (1, 0, 'user', 'after')").run();
			expect(count(agent, "backlog_comments")).toBe(comments + 1);
			// Process state is not carried.
			expect(kept(file)).toBeUndefined();
			const record = JSON.parse(
				(agent.db.prepare("SELECT value FROM meta WHERE key = 'carried_from_retired'").get() as { value: string })
					.value,
			) as { file: string; version: number; carried: Record<string, number>; left: Record<string, string> };
			expect(record.file).toBe(`${file}.v${older.version}.retired`);
			expect(record.version).toBe(older.version);
			expect(record.carried).toMatchObject({
				workspaces: 1,
				memories: 1,
				backlog: 1,
				backlog_notes: 1,
				trusted_folders: 1,
			});
			expect(record.left).toEqual({});
		} finally {
			agent.close();
		}
		// The retired file still holds everything.
		expect(kept(`${file}.v${older.version}.retired`)).toBe("me");
	});

	it("adds the jobs table and the lease item to a file made before them, in place, while an older Octocode still has it open", () => {
		// What an Octocode built before the additions creates and opens: the same version, without them, adding nothing.
		const before: FileKind = {
			...COORDINATION_FILE,
			amend: undefined,
			create: (db) => {
				const made = COORDINATION_FILE.create(db);
				db.exec("DROP TABLE jobs; ALTER TABLE leases DROP COLUMN item;");
				return made;
			},
		};
		const file = previous(before);
		const old = open(file, before);
		try {
			const agent = open(file);
			try {
				expect(versionOf(file)).toBe(COORDINATION_FILE.version);
				expect(count(agent, "jobs")).toBe(0);
				expect(agent.db.prepare("SELECT name FROM pragma_table_info('leases') WHERE name = 'item'").all()).toHaveLength(
					1,
				);
				// The same file, every row in place: nothing was set aside or carried.
				expect(agent.db.prepare("SELECT title FROM backlog").all()).toEqual([{ title: "Ship the carry step" }]);
				expect(agent.db.prepare("SELECT value FROM meta WHERE key = 'carried_from_retired'").get()).toBeUndefined();
				expect(fs.readdirSync(path.dirname(file)).filter((name) => name.includes(".retired"))).toEqual([]);
			} finally {
				agent.close();
			}
			// The older Octocode keeps writing and reading through the change.
			old.db.prepare("INSERT INTO meta (key, value) VALUES ('old', 'still here')").run();
			expect(old.db.prepare("SELECT title FROM backlog").all()).toEqual([{ title: "Ship the carry step" }]);
		} finally {
			old.close();
		}
		// A complete file is opened without another change.
		const again = open(file);
		again.close();
		expect(read<{ value: string }>(file, "SELECT value FROM meta WHERE key = 'old'")?.value).toBe("still here");
	});

	it("leaves a table whose columns the new schema lacks in the retired file, with the tables that need it", () => {
		const legacy: FileKind = {
			...older,
			create: (db) => {
				const made = older.create(db);
				db.exec("ALTER TABLE workspaces ADD COLUMN legacy TEXT");
				return made;
			},
		};
		const file = previous(legacy);
		const agent = open(file);
		try {
			expect(count(agent, "memories")).toBe(0);
			expect(count(agent, "backlog")).toBe(0);
			expect(count(agent, "trusted_folders")).toBe(1);
			const { left } = JSON.parse(
				(agent.db.prepare("SELECT value FROM meta WHERE key = 'carried_from_retired'").get() as { value: string })
					.value,
			) as { left: Record<string, string> };
			expect(left.workspaces).toBe("the new schema has no legacy");
			expect(left.memories).toBe("needs workspaces, which was not carried");
		} finally {
			agent.close();
		}
		const retired = new DatabaseSync(`${file}.v${older.version}.retired`, { readOnly: true });
		try {
			expect(retired.prepare("SELECT title FROM memories").get()).toEqual({ title: "Answer in tables" });
		} finally {
			retired.close();
		}
	});
});
