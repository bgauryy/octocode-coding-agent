import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSessionEntries, parseSessionEntryLine } from "../../src/core/session-manager/entries.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { readJournal } from "../../src/octocode/files/checkpoint-store.ts";
import { userMsg } from "../utilities.ts";

// Four readers parse JSONL with one shared line parser but different policies for a line that is not valid JSON:
// a transcript load skips it, a merge of another process's records refuses it, a checkpoint journal skips it and
// marks itself for rewrite. These tests pin each policy through its public entry point.

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "jsonl-policies-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("transcript load", () => {
	it("skips blank and malformed lines and keeps the records around them", () => {
		const text = '{"type":"session","id":"s"}\n\n{torn\n{"type":"custom","id":"c"}\n';
		expect(parseSessionEntries(text).map((entry) => (entry as { id: string }).id)).toEqual(["s", "c"]);
		expect(parseSessionEntryLine("{torn")).toBeNull();
		expect(parseSessionEntryLine("  ")).toBeNull();
		expect(parseSessionEntryLine('{"type":"custom"}')).toEqual({ type: "custom" });
	});
});

describe("merging another process's records", () => {
	it("refuses a malformed record instead of skipping it", () => {
		const seed = SessionManager.create(dir, dir);
		seed.appendMessage(userMsg("hello"));
		const file = seed.getSessionFile()!;
		const writer = SessionManager.open(file, dir, dir);
		appendFileSync(file, "{not json\n");
		expect(() => writer.appendCustomEntry("x", 1)).toThrow(/malformed record written by another process/);
	});
});

describe("checkpoint journal", () => {
	it("skips a malformed line mid-file and marks the journal dirty", () => {
		const store = join(dir, "cp");
		mkdirSync(store, { recursive: true });
		const good = (turn: number) =>
			`${JSON.stringify({ turn, path: "/x", before: null, after: "a".repeat(64), bytes: 0 })}\n`;
		writeFileSync(join(store, "journal.jsonl"), `${good(1)}{torn\n\n${good(2)}`);
		const { entries, dirty } = readJournal(store);
		expect(entries.map((entry) => entry.turn)).toEqual([1, 2]);
		expect(dirty).toBe(true);
	});

	it("is clean when every line is a settled record", () => {
		const store = join(dir, "cp");
		mkdirSync(store, { recursive: true });
		writeFileSync(
			join(store, "journal.jsonl"),
			`${JSON.stringify({ turn: 1, path: "/x", before: null, after: "a".repeat(64), bytes: 0 })}\n\n`,
		);
		expect(readJournal(store).dirty).toBe(false);
	});
});
