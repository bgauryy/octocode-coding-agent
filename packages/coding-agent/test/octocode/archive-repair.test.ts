import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registeredWorkspace } from "../../src/config/workspace-database.ts";
import { openAgentDb } from "../../src/config/database.ts";
import { compactions } from "../../../db/src/api.ts";
import { HistoryRepair } from "../../src/octocode/archive/repair.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

it("parses shared ancestors once per recovery batch and observes new entries in a later batch", async () => {
	const root = tmp();
	const db = openAgentDb(path.join(root, "agent.db"));
	registeredWorkspace(root, db);
	const env = { OCTOCODE_HOME: path.join(root, "home") };
	const parent = path.join(root, "parent.jsonl");
	const header = { type: "session", version: 3, id: "parent", cwd: root, timestamp: "2026-01-01T00:00:00Z" };
	const entry = {
		type: "compaction",
		id: "first",
		parentId: null,
		timestamp: header.timestamp,
		summary: "original decision",
		firstKeptEntryId: "kept",
		tokensBefore: 100,
	};
	const write = (file: string, rows: object[]) =>
		fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	write(parent, [header, entry]);
	const forks = Array.from({ length: 3 }, (_, i) => {
		const file = path.join(root, `fork-${i}.jsonl`);
		write(file, [{ ...header, id: `fork-${i}`, parentSession: parent }, entry]);
		return file;
	});
	try {
		const opened = vi.spyOn(fs.promises, "open");
		const repair = new HistoryRepair(db, env);
		for (const file of forks) await repair.transcript(file);
		expect(opened).toHaveBeenCalledTimes(4);
		expect(compactions.forSession(db.db, "parent")).toHaveLength(1);
		for (let i = 0; i < 3; i++) expect(compactions.forSession(db.db, `fork-${i}`)).toHaveLength(0);
		write(parent, [header, entry, { ...entry, id: "second", summary: "new decision" }]);
		await new HistoryRepair(db, env).transcript(forks[0]);
		expect(compactions.forSession(db.db, "parent")).toHaveLength(2);
		const stop = new AbortController();
		stop.abort();
		await expect(new HistoryRepair(db, env, stop.signal).transcript(parent)).rejects.toThrow();
		expect(opened).toHaveBeenCalledTimes(6);
	} finally {
		db.close();
	}
});

function transcriptFixture() {
	const root = tmp();
	const db = openAgentDb(path.join(root, "agent.db"));
	registeredWorkspace(root, db);
	const env = { OCTOCODE_HOME: path.join(root, "home") };
	const file = path.join(root, "long.jsonl");
	const header = { type: "session", version: 3, id: "long", cwd: root, timestamp: "2026-01-01T00:00:00Z" };
	const compaction = (id: string) => ({
		type: "compaction",
		id,
		parentId: null,
		timestamp: header.timestamp,
		summary: `décision ✓ ${id}`,
		firstKeptEntryId: "kept",
		tokensBefore: 100,
	});
	// Rows of multibyte text larger than one read, so records and characters cross read boundaries; CRLF line ends.
	const filler = (n: number) => ({ type: "message", id: `m${n}`, text: "é✓".repeat(15_000 + n) });
	const rows = [header, filler(0), compaction("one"), filler(1), filler(2), compaction("two"), filler(3)];
	fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\r\n") + "\r\n");
	return { db, env, file };
}

it("reads every compaction of a transcript larger than one read, across multibyte and CRLF boundaries", async () => {
	const { db, env, file } = transcriptFixture();
	try {
		expect(fs.statSync(file).size).toBeGreaterThan(3 * 64 * 1024);
		await new HistoryRepair(db, env).transcript(file);
		expect(compactions.forSession(db.db, "long").map((row) => row.summary)).toEqual([
			"décision ✓ one",
			"décision ✓ two",
		]);
	} finally {
		db.close();
	}
});

it("an abort during a read rejects the repair and closes the file, with no stray error", async () => {
	const { db, env, file } = transcriptFixture();
	const stop = new AbortController();
	const open = fs.promises.open.bind(fs.promises);
	let close: ReturnType<typeof vi.fn> | undefined;
	vi.spyOn(fs.promises, "open").mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
		const handle = await open(...args);
		close = vi.fn(handle.close.bind(handle));
		handle.close = close as typeof handle.close;
		stop.abort();
		return handle;
	});
	const stray = vi.fn();
	process.on("uncaughtException", stray);
	try {
		await expect(new HistoryRepair(db, env, stop.signal).transcript(file)).rejects.toMatchObject({
			name: "AbortError",
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(close).toHaveBeenCalledTimes(1);
		expect(stray).not.toHaveBeenCalled();
	} finally {
		process.off("uncaughtException", stray);
		db.close();
	}
});
