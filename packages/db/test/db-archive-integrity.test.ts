import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { archiveHistory, configAudits, DbWriter, history, openDatabase, type AgentDb } from "../src/api.ts";
import { appendArchive, archiveSource, type ArchiveRow } from "../src/history-archive.ts";
import { tmp } from "./helpers.ts";

const NOW = Date.UTC(2026, 10, 15);
const AT = Date.UTC(2026, 9, 25);
let agent: AgentDb;
beforeEach(() => {
	const root = tmp();
	agent = openDatabase({
		file: path.join(root, "agent.db"),
		mirrorFile: path.join(root, "mirror.db"),
		archiveDir: path.join(root, "archive"),
		privateParent: false,
	});
	configAudits.record(agent.db, {
		at: AT,
		actor: "fixture",
		action: "provider.toggle",
		target: "keep-me",
		outcome: "ok",
	});
	fs.mkdirSync(agent.archiveDir);
});
afterEach(() => {
	vi.restoreAllMocks();
	agent.close();
});

it.each([
	{ db: "source", id: "1", row: { id: 1 } },
	{ db: "source", id: "1", at: AT, row: null },
	{ id: "1", at: AT, row: { id: 1 } },
	{ db: "source", id: "1", at: AT, row: { nested: { lost: true } } },
])("refuses malformed archive envelopes without discarding archive or source rows: %j", (malformed) => {
	const file = path.join(agent.archiveDir, "config-audits-2026-10.jsonl.gz");
	const bytes = zlib.gzipSync(`${JSON.stringify(malformed)}\n`);
	fs.writeFileSync(file, bytes);
	expect(() => archiveHistory(agent, NOW, { archiveAfterDays: 14, keepDays: 0 })).toThrow();
	expect(fs.readFileSync(file)).toEqual(bytes);
	expect(history.rowsBefore(agent.db, "config_audits", NOW, 10)).toHaveLength(1);
});

it("refuses a truncated gzip member without replacing it or deleting source rows", () => {
	const file = path.join(agent.archiveDir, "config-audits-2026-10.jsonl.gz");
	const bytes = zlib.gzipSync("{}\n").subarray(0, -4);
	fs.writeFileSync(file, bytes);
	expect(() => archiveHistory(agent, NOW, { archiveAfterDays: 14, keepDays: 0 })).toThrow();
	expect(fs.readFileSync(file)).toEqual(bytes);
	expect(history.rowsBefore(agent.db, "config_audits", NOW, 10)).toHaveLength(1);
});

it("refuses a malformed audit ordering id before changing archives or deleting source history", () => {
	const file = path.join(agent.archiveDir, "audits-2026-10.jsonl.gz");
	const good = { db: archiveSource(agent), id: "1", at: AT, row: { id: 1, workspace_id: "ws", backlog_id: "B1" } };
	const bad = { ...good, id: "2", row: { ...good.row, id: "bogus" } };
	const bytes = zlib.gzipSync(`${JSON.stringify(good)}\n${JSON.stringify(bad)}\n`);
	fs.writeFileSync(file, bytes);
	expect(() => archiveHistory(agent, NOW)).toThrow();
	expect(fs.readFileSync(file)).toEqual(bytes);
	expect(history.rowsBefore(agent.db, "config_audits", NOW, 10)).toHaveLength(1);
});

it("does not recompress or replace identical archive retries", () => {
	const row = history.rowsBefore(agent.db, "config_audits", NOW, 10)[0];
	const records = [{ db: archiveSource(agent), id: String(row.id), at: AT, row: row as ArchiveRow }];
	appendArchive(agent.archiveDir, "config-audits", records, NOW, Infinity);
	const file = path.join(agent.archiveDir, "config-audits-2026-10.jsonl.gz");
	const before = fs.statSync(file, { bigint: true });
	const compress = vi.spyOn(zlib, "gzipSync");
	const flush = vi.spyOn(fs, "fsyncSync");
	appendArchive(agent.archiveDir, "config-audits", records, NOW, Infinity);
	expect(compress).not.toHaveBeenCalled();
	expect(flush).toHaveBeenCalled();
	expect(fs.statSync(file, { bigint: true }).ino).toBe(before.ino);
	expect(fs.statSync(file, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
});

it.each(["before-rename", "before-delete", "after-delete"])("replays safely after interruption %s", (stage) => {
	const file = path.join(agent.archiveDir, "config-audits-2026-10.jsonl.gz");
	const initial = history.rowsBefore(agent.db, "config_audits", NOW, 10);
	if (stage === "before-rename") {
		const rename = fs.renameSync;
		vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
			if (path.basename(String(to)) === path.basename(file)) throw new Error("interrupted before archive commit");
			return rename(from, to);
		});
	} else {
		const transaction = agent.transaction;
		vi.spyOn(agent, "transaction").mockImplementation((work) => {
			if (stage === "after-delete") transaction(work);
			throw new Error(`interrupted ${stage}`);
		});
	}
	expect(() => archiveHistory(agent, NOW, { archiveAfterDays: 14, keepDays: 0 })).toThrow("interrupted");
	const source = history.rowsBefore(agent.db, "config_audits", NOW, 10);
	const archived = fs.existsSync(file)
		? zlib
				.gunzipSync(fs.readFileSync(file))
				.toString()
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).row)
		: [];
	expect(new Map([...source, ...archived].map((row) => [row.id, row])).size).toBe(1);
	expect(stage === "before-rename" ? source : archived).toEqual(initial);
	expect(fs.readdirSync(agent.archiveDir).some((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toBe(false);
	vi.restoreAllMocks();
	archiveHistory(agent, NOW, { archiveAfterDays: 14, keepDays: 0 });
	expect(history.rowsBefore(agent.db, "config_audits", NOW, 10)).toEqual([]);
	expect(
		zlib
			.gunzipSync(fs.readFileSync(file))
			.toString()
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).row),
	).toEqual(initial);
});

it("preserves colliding row ids from concurrent databases sharing an archive", async () => {
	const root = tmp();
	const other = openDatabase({
		file: path.join(root, "other.db"),
		mirrorFile: path.join(root, "mirror.db"),
		archiveDir: agent.archiveDir,
		privateParent: false,
	});
	const writers = [agent, other].map(
		(db) => new DbWriter({ file: db.file, mirrorFile: db.mirrorFile, archiveDir: db.archiveDir, privateParent: false }),
	);
	try {
		for (const db of [agent, other])
			db.transaction(() => {
				for (let n = 0; n < 500; n++)
					configAudits.record(db.db, {
						at: AT,
						actor: "fixture",
						action: "provider.toggle",
						target: `${archiveSource(db)}-${n}`,
						outcome: "ok",
					});
			});
		const expected = [agent, other].flatMap((db) =>
			history
				.rowsBefore(db.db, "config_audits", NOW, 1000)
				.map((row) => ({ db: archiveSource(db), id: String(row.id), at: AT, row })),
		);
		const first = await Promise.all(
			writers.map((writer) => writer.archive(NOW, { archiveAfterDays: 14, keepDays: 0 })),
		);
		for (const [index, result] of first.entries())
			if (result.skipped) await writers[index].archive(NOW, { archiveAfterDays: 14, keepDays: 0 });
		for (const db of [agent, other]) expect(history.rowsBefore(db.db, "config_audits", NOW, 1000)).toEqual([]);
		const file = path.join(agent.archiveDir, "config-audits-2026-10.jsonl.gz");
		const archived = zlib
			.gunzipSync(fs.readFileSync(file))
			.toString()
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(archived).toHaveLength(expected.length);
		expect(archived).toEqual(expect.arrayContaining(expected));
	} finally {
		for (const writer of writers) writer.close();
		other.close();
	}
});
