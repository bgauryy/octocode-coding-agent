import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type AgentDb, openDatabase } from "../src/db.ts";
import { AgentDbError, baseVersion, COORDINATION_FILE } from "../src/schema.ts";
import { loadSqlite } from "../src/sqlite.ts";
import { tmp } from "./helpers.ts";

const { DatabaseSync } = loadSqlite();

const open = (file: string): AgentDb =>
	openDatabase({
		file,
		mirrorFile: `${file}.transcripts`,
		archiveDir: path.join(path.dirname(file), "archive"),
		privateParent: false,
	});

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
		expect(versionOf(file)).toBe(baseVersion(COORDINATION_FILE));
		open(file).close();
		expect(kept(file)).toBe("me");
	});

	it("refuses a file at an older version no upgrade step starts from, and changes nothing in it", () => {
		const file = current();
		const raw = new DatabaseSync(file);
		raw.exec("PRAGMA user_version=9");
		raw.close();
		const before = fs.readFileSync(file);
		expect(() => open(file)).toThrow(/older than this Octocode's .*cannot upgrade it/);
		expect(fs.readFileSync(file)).toEqual(before);
		expect(fs.existsSync(`${file}.v9.bak`)).toBe(false);
	});

	it("refuses a file at a newer version and changes nothing in it", () => {
		const file = current();
		const raw = new DatabaseSync(file);
		raw.exec(`DROP TABLE schema_meta; PRAGMA user_version=${COORDINATION_FILE.version + 1}`);
		raw.close();
		const before = fs.readFileSync(file);
		expect(() => open(file)).toThrow(AgentDbError);
		expect(() => open(file)).toThrow(/newer than this Octocode's/);
		expect(fs.readFileSync(file)).toEqual(before);
	});

	it("refuses a file that is not one of Octocode's", () => {
		const file = path.join(tmp(), "foreign.db");
		const raw = new DatabaseSync(file);
		raw.exec("CREATE TABLE theirs (x)");
		raw.close();
		expect(() => open(file)).toThrow(/is not an Octocode agent database/);
	});
});

describe("the coordination schema", () => {
	const shape = JSON.parse(
		fs.readFileSync(path.join(import.meta.dirname, "fixtures", "coordination-shape.json"), "utf8"),
	) as { tables: Record<string, string[]>; indexes: string[] };

	it("creates exactly the tables, columns and indexes of the current file", () => {
		const agent = open(path.join(tmp(), "workspaces.db"));
		try {
			const tables = agent.db
				.prepare(
					"SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memories_fts%' ORDER BY name",
				)
				.all() as { name: string }[];
			const found: Record<string, string[]> = {};
			for (const { name } of tables)
				found[name] = (
					agent.db
						.prepare(`SELECT name, type, "notnull" AS nn, dflt_value AS dflt, pk FROM pragma_table_info('${name}')`)
						.all() as { name: string; type: string; nn: number; dflt: string | null; pk: number }[]
				).map(
					(c) =>
						`${c.name} ${c.type}${c.nn ? " NOT NULL" : ""}${c.dflt !== null ? ` DEFAULT ${c.dflt}` : ""}${c.pk ? ` PK${c.pk}` : ""}`,
				);
			expect(found).toEqual(shape.tables);
			const indexes = agent.db
				.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
				.all() as { name: string }[];
			expect(indexes.map((row) => row.name)).toEqual(shape.indexes);
		} finally {
			agent.close();
		}
	});

	it("gives a version-10 file the objects it lacks when it is upgraded", () => {
		const file = current();
		const raw = new DatabaseSync(file);
		raw.exec("DROP TABLE item_handoffs; DROP INDEX agent_runs_parent_session; PRAGMA user_version=10");
		raw.close();
		open(file).close();
		const names = read<{ n: number }>(
			file,
			"SELECT COUNT(*) AS n FROM sqlite_schema WHERE name IN ('item_handoffs', 'item_handoffs_by', 'agent_runs_parent_session')",
		);
		expect(names?.n).toBe(3);
	});
});
