import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ArchiveIndexDb, openArchiveIndex } from "../src/db.ts";
import * as archiveIndex from "../src/queries/archive-index.ts";
import { loadSqlite } from "../src/sqlite.ts";
import { tmp } from "./helpers.ts";

const opened: ArchiveIndexDb[] = [];
const open = (file: string) => {
	const index = openArchiveIndex(file);
	opened.push(index);
	return index;
};
afterEach(() => {
	for (const index of opened.splice(0)) index.close();
});

const passage = (start: number, body: string, context: string | null = null) => ({
	start,
	end: start + 1,
	length: body.split(" ").length,
	byteStart: start * 10,
	byteEnd: start * 10 + 9,
	context,
	body,
});
const everyFile = (index: ArchiveIndexDb) => archiveIndex.files(index.db).map((file) => file.id);
const stamp = (file: string, size = 1) => ({ path: file, size, mtime: 1.5, ino: 7 });

describe("archive index queries", () => {
	it("counts each term per passage, keeping identifiers and paths whole", () => {
		const index = open(path.join(tmp(), "archive-index.db"));
		expect(index.fts).toBe(true);
		index.transaction(() =>
			archiveIndex.replaceFile(index.db, stamp("/a/SESSION.md"), [
				passage(0, "auth-storage/keychain.ts auth storage keychain.ts keychain t auth"),
				passage(2, "registry cach cach οδοσ", '{"before":["## "],"after":[]}'),
			]),
		);
		const counts = archiveIndex.termCounts(
			index.db,
			["auth", "auth-storage/keychain.ts", "cach", "οδοσ", "missing"],
			everyFile(index),
		);
		const seen = Object.fromEntries(counts.map(([, , term, count, start]) => [`${term}@${start}`, count]));
		expect(seen).toEqual({ "auth@0": 2, "auth-storage/keychain.ts@0": 1, "cach@2": 2, "οδοσ@2": 1 });
		const [passage2, file, , , start, end, length] = counts.find((count) => count[2] === "cach")!;
		expect({ start, end, length }).toEqual({ start: 2, end: 3, length: 4 });
		expect(file).toBe(archiveIndex.files(index.db)[0].id);
		const [range] = archiveIndex.passageRanges(index.db, [passage2, 999_999]);
		expect(range).toMatchObject({ id: passage2, byteStart: 20, byteEnd: 29 });
		expect(JSON.parse(range.context!)).toEqual({ before: ["## "], after: [] });
		expect(archiveIndex.passageRanges(index.db, [999_999])).toEqual([]);
		expect(archiveIndex.termCounts(index.db, [], everyFile(index))).toEqual([]);
	});

	it("counts only the scoped files' passages however large the unrelated corpus grows", () => {
		const index = open(path.join(tmp(), "archive-index.db"));
		index.transaction(() =>
			archiveIndex.replaceFile(index.db, stamp("/scoped"), [passage(0, "shared term"), passage(2, "shared")]),
		);
		const [scoped] = archiveIndex.files(index.db);
		const rows = () => archiveIndex.termCounts(index.db, ["shared"], [scoped.id]);
		const before = rows();
		expect(before).toHaveLength(2);
		for (const size of [10, 200]) {
			index.transaction(() => {
				for (let n = 0; n < size; n++)
					archiveIndex.replaceFile(index.db, stamp(`/other${size}-${n}`), [passage(0, "shared noise")]);
			});
			expect(rows()).toEqual(before);
			expect(rows().every((row) => row[1] === scoped.id)).toBe(true);
		}
		expect(archiveIndex.termCounts(index.db, ["shared"], everyFile(index)).length).toBeGreaterThan(before.length);
		expect(archiveIndex.termCounts(index.db, ["shared"], [])).toEqual([]);
		const many = Array.from({ length: 50_000 }, (_, n) => n + 1_000_000);
		expect(archiveIndex.termCounts(index.db, ["shared"], [...many, scoped.id])).toEqual(before);
	});

	it("looks each term row up in passages by key and never scans passages", () => {
		const index = open(path.join(tmp(), "archive-index.db"));
		index.transaction(() => archiveIndex.replaceFile(index.db, stamp("/a"), [passage(0, "word")]));
		const plan = index.db
			.prepare(
				`EXPLAIN QUERY PLAN SELECT v.doc FROM passages_terms v JOIN passages p ON p.id = v.doc
				WHERE v.term IN ('word') AND p.file IN (SELECT value FROM json_each(?)) GROUP BY v.doc, v.term`,
			)
			.all("[1]")
			.map((row) => String(row.detail));
		expect(plan.some((line) => line.startsWith("SEARCH p USING INTEGER PRIMARY KEY"))).toBe(true);
		expect(plan.some((line) => /^SCAN p\b/.test(line))).toBe(false);
	});

	it("replaces a re-indexed file's passages and removes a deleted file's", () => {
		const index = open(path.join(tmp(), "archive-index.db"));
		index.transaction(() => {
			archiveIndex.replaceFile(index.db, stamp("/a"), [passage(0, "old words")]);
			archiveIndex.replaceFile(index.db, stamp("/b"), [passage(0, "other old")]);
		});
		index.transaction(() => archiveIndex.replaceFile(index.db, stamp("/a", 2), [passage(0, "new"), passage(2, "new")]));
		expect(archiveIndex.termCounts(index.db, ["old"], everyFile(index)).map((row) => row[3])).toEqual([1]);
		expect(archiveIndex.termCounts(index.db, ["new"], everyFile(index))).toHaveLength(2);
		index.transaction(() => archiveIndex.deleteFiles(index.db, ["/b", "/never-indexed"]));
		expect(archiveIndex.termCounts(index.db, ["old", "other"], everyFile(index))).toEqual([]);
		expect(archiveIndex.files(index.db)).toEqual([
			{ id: expect.any(Number), path: "/a", size: 2, mtime: 1.5, ino: 7, passages: 2, words: 2 },
		]);
	});

	it("keeps meta values and clears everything on request", () => {
		const index = open(path.join(tmp(), "archive-index.db"));
		expect(archiveIndex.readMeta(index.db, "tokenizer")).toBeUndefined();
		archiveIndex.writeMeta(index.db, "tokenizer", "1");
		archiveIndex.writeMeta(index.db, "tokenizer", "2");
		expect(archiveIndex.readMeta(index.db, "tokenizer")).toBe("2");
		index.transaction(() => archiveIndex.replaceFile(index.db, stamp("/a"), [passage(0, "word")]));
		index.transaction(() => archiveIndex.clear(index.db));
		expect(archiveIndex.files(index.db)).toEqual([]);
		expect(archiveIndex.termCounts(index.db, ["word"], [1])).toEqual([]);
	});

	it("refuses an index at an older schema version", () => {
		const file = path.join(tmp(), "archive-index.db");
		const index = open(file);
		index.transaction(() => archiveIndex.replaceFile(index.db, stamp("/a"), [passage(0, "word")]));
		index.close();
		opened.splice(0);
		const { DatabaseSync } = loadSqlite();
		const raw = new DatabaseSync(file);
		raw.exec("PRAGMA user_version = 0");
		raw.close();
		// Version 0 with a header id and tables reads as an older Octocode file.
		expect(() => open(file)).toThrow(/older than this Octocode's/);
	});

	it("creates the tables without the full-text index where SQLite has no FTS5", () => {
		const { DatabaseSync } = loadSqlite();
		const db = new DatabaseSync(":memory:");
		const real = db.exec.bind(db);
		db.exec = (sql: string) => {
			if (sql.includes("fts5")) throw new Error("no such module: fts5");
			real(sql);
		};
		expect(archiveIndex.create(db)).toEqual({ fts: false });
		expect(archiveIndex.hasFts(db)).toBe(false);
		expect(archiveIndex.files(db)).toEqual([]);
		db.close();
	});
});
