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
