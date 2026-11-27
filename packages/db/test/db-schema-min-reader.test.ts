import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type AgentDb, openDatabase } from "../src/db.ts";
import { COORDINATION_MIGRATIONS } from "../src/schema-migrations.ts";
import { AgentDbError, COORDINATION_FILE, type FileKind } from "../src/schema.ts";
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

const sql = (file: string, statement: string): void => {
	const db = new DatabaseSync(file);
	try {
		db.exec(statement);
	} finally {
		db.close();
	}
};
const stamp = (file: string): number | undefined => {
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return (db.prepare("SELECT min_reader FROM schema_meta").get() as { min_reader: number } | undefined)?.min_reader;
	} finally {
		db.close();
	}
};
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** A closed, current coordination file. */
function fresh(): string {
	const file = path.join(tmp(), "workspaces.db");
	open(file).close();
	return file;
}

/** A closed file at `version` stamped `minReader`, as a newer build would leave it. */
function newer(version: number, minReader: number | undefined): string {
	const file = fresh();
	sql(file, minReader === undefined ? "DROP TABLE schema_meta" : `UPDATE schema_meta SET min_reader=${minReader}`);
	sql(file, `PRAGMA user_version=${version}`);
	return file;
}

describe("the oldest-compatible-reader stamp", () => {
	it("stamps a fresh file with the oldest version that can read it, below its own version", () => {
		expect(COORDINATION_FILE.minReader).toBe(10);
		expect(stamp(fresh())).toBe(10);
	});

	it("opens a newer file stamped compatible without migrating or rewriting it (V1)", () => {
		const file = newer(COORDINATION_FILE.version + 1, COORDINATION_FILE.version - 1);
		const before = hash(file);
		open(file).close();
		expect(hash(file)).toBe(before);
	});

	it("refuses a newer file stamped above this build, naming the stamp, the backup and the isolation variables (V2)", () => {
		const file = newer(COORDINATION_FILE.version + 2, COORDINATION_FILE.version + 1);
		fs.writeFileSync(`${file}.v11.bak`, "copy");
		const before = hash(file);
		let error: unknown;
		try {
			open(file);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(AgentDbError);
		const message = (error as Error).message;
		expect(message).toContain(`version ${COORDINATION_FILE.version + 2}`);
		expect(message).toContain(`${file}.v11.bak`);
		expect(message).toMatch(/OCTOCODE_HOME.*OCTOCODE_AGENT_DB/);
		expect(hash(file)).toBe(before);
	});

	it("refuses a newer file without a stamp and names no backup when none exists", () => {
		const file = newer(COORDINATION_FILE.version + 1, undefined);
		expect(() => open(file)).toThrow(/newer than this Octocode's(?!.*copy taken)/);
	});

	it("stamps an older file after a non-breaking upgrade at its from-version, and a legacy current file once", () => {
		const old = fresh();
		sql(old, "DROP TABLE schema_meta; PRAGMA user_version=10");
		open(old).close();
		expect(stamp(old)).toBe(10);
		const legacy = fresh();
		sql(legacy, "DROP TABLE schema_meta");
		open(legacy).close();
		expect(stamp(legacy)).toBe(10);
	});

	it("raises the stamp to the target of a breaking step and never lowers it", () => {
		const breaking: FileKind = {
			...COORDINATION_FILE,
			version: 13,
			optionalStep: undefined,
			migrations: [...COORDINATION_MIGRATIONS, { from: 12, breaking: true, run: () => {} }],
		};
		const file = fresh();
		open(file, breaking).close();
		expect(stamp(file)).toBe(13);
		const kept: FileKind = {
			...breaking,
			version: 14,
			migrations: [...breaking.migrations!, { from: 13, breaking: false, run: () => {} }],
		};
		open(file, kept).close();
		expect(stamp(file)).toBe(13);
	});

	it("pins every migration's breaking flag", () => {
		expect(COORDINATION_MIGRATIONS.map((step) => [step.from, step.breaking])).toEqual([
			[10, false],
			[11, false],
		]);
	});
});
