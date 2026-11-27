import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import zlib, { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	type AgentDb,
	configAudits,
	DEFAULT_HISTORY_WINDOWS,
	DbWriter,
	DbWriterUnavailableError,
	history,
	openDatabase,
	DB_WRITER_QUEUE_LIMIT,
} from "../src/api.ts";
import { tmp } from "./helpers.ts";
import { appendArchive, archiveSource, archivedAudits } from "../src/history-archive.ts";

const NOW = Date.UTC(2026, 10, 15, 12);
let agent: AgentDb;
let writer: DbWriter;
const locations = () => ({
	file: agent.file,
	mirrorFile: agent.mirrorFile,
	archiveDir: agent.archiveDir,
	privateParent: false,
});
beforeEach(() => {
	const root = tmp();
	agent = openDatabase({
		file: path.join(root, "agent.db"),
		mirrorFile: path.join(root, "mirror.db"),
		archiveDir: path.join(root, "archive"),
		privateParent: false,
	});
	writer = new DbWriter(locations());
	configAudits.record(agent.db, {
		at: NOW - 20 * 86400000,
		actor: "fixture",
		action: "provider.toggle",
		target: "fixture",
		outcome: "ok",
	});
});
afterEach(() => {
	writer.close();
	agent.close();
	vi.restoreAllMocks();
});
const archiveFile = () => path.join(agent.archiveDir, "config-audits-2026-10.jsonl.gz");
const remaining = () => history.rowsBefore(agent.db, "config_audits", NOW, 10);

it("runs compression and durable replacement off the calling thread before deleting source rows", async () => {
	const write = vi.spyOn(fs, "writeFileSync");
	const compress = vi.spyOn(zlib, "gzipSync");
	expect(await writer.archive(NOW, DEFAULT_HISTORY_WINDOWS)).toEqual({ archived: 1, deleted: 1 });
	expect(remaining()).toHaveLength(0);
	const archived = gunzipSync(fs.readFileSync(archiveFile()))
		.toString()
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(archived).toHaveLength(1);
	expect(archived[0].row.target).toBe("fixture");
	expect(fs.statSync(archiveFile()).mode & 0o777).toBe(0o600);
	expect(compress).not.toHaveBeenCalled();
	expect(write).not.toHaveBeenCalled();
});

it("refuses a corrupt destination without replacing it or deleting source history", async () => {
	fs.mkdirSync(agent.archiveDir);
	const corrupt = Buffer.from("not gzip");
	fs.writeFileSync(archiveFile(), corrupt);
	await expect(writer.archive(NOW, DEFAULT_HISTORY_WINDOWS)).rejects.toThrow();
	expect(fs.readFileSync(archiveFile())).toEqual(corrupt);
	expect(remaining()).toHaveLength(1);
});

it("selects only the requested database, item, cursor and retention window inside the worker", async () => {
	const at = NOW - 20 * 86400000;
	const records = [
		{ db: archiveSource(agent), id: "1", at, row: { id: 1, workspace_id: "ws", backlog_id: "B1" } },
		{ db: archiveSource(agent), id: "2", at, row: { id: 2, workspace_id: "ws", backlog_id: "B1" } },
		{ db: archiveSource(agent), id: "3", at, row: { id: 3, workspace_id: "ws", backlog_id: "B2" } },
		{ db: "other-db", id: "4", at, row: { id: 4, workspace_id: "ws", backlog_id: "B1" } },
	];
	appendArchive(agent.archiveDir, "audits", records, NOW, Number.POSITIVE_INFINITY);
	const query = { now: NOW, repo: "ws", ref: "B1", before: 3, limit: 1, windows: DEFAULT_HISTORY_WINDOWS };
	expect(await writer.archivedAudits(query)).toEqual(archivedAudits(agent, NOW, "ws", "B1", 3, 1));
	expect(await writer.archivedAudits(query)).toEqual([records[1].row]);
	expect(await writer.archivedAudits({ ...query, windows: { archiveAfterDays: 14, keepDays: 7 } })).toEqual([]);
});

it("does not run compression inline if the worker fails to load", async () => {
	writer.close();
	writer = new DbWriter(locations(), { entry: new URL("file:///missing/archive-worker.mjs") });
	await expect(writer.archive(NOW, DEFAULT_HISTORY_WINDOWS)).rejects.toBeInstanceOf(DbWriterUnavailableError);
	expect(writer.stats()).toMatchObject({ mode: "inline", inlineRuns: 0, fallback: "load-failed" });
	expect(remaining()).toHaveLength(1);
	expect(fs.existsSync(archiveFile())).toBe(false);
});

it("bounds maintenance admission and leaves source rows intact when its worker is stopped", async () => {
	writer.close();
	writer = new DbWriter(locations(), { entry: new URL("data:text/javascript,setInterval(() => {}, 1000)") });
	const pending = Array.from({ length: DB_WRITER_QUEUE_LIMIT }, () => writer.archive(NOW, DEFAULT_HISTORY_WINDOWS));
	const outcomes = Promise.allSettled(pending);
	await expect(writer.archive(NOW, DEFAULT_HISTORY_WINDOWS)).rejects.toMatchObject({ code: "DB_WRITER_BUSY" });
	writer.close();
	expect((await outcomes).every((result) => result.status === "rejected")).toBe(true);
	expect(writer.pending).toBe(0);
	expect(remaining()).toHaveLength(1);
	expect(fs.existsSync(archiveFile())).toBe(false);
	await expect(writer.archive(NOW, DEFAULT_HISTORY_WINDOWS)).rejects.toBeInstanceOf(DbWriterUnavailableError);
});

it("releases an active archive lock after close and lets a replacement writer retry without losing rows", async () => {
	agent.transaction(() => {
		for (let index = 0; index < 4999; index++)
			configAudits.record(agent.db, {
				at: NOW - 20 * 86400000,
				actor: "fixture",
				action: "provider.toggle",
				target: randomBytes(1536).toString("base64"),
				outcome: "ok",
			});
	});
	const cancelled = writer.archive(NOW, DEFAULT_HISTORY_WINDOWS);
	const outcome = Promise.allSettled([cancelled]);
	await vi.waitFor(() => expect(fs.existsSync(`${archiveFile()}.lock.owner`)).toBe(true), { interval: 1 });
	writer.close();
	expect((await outcome)[0].status).toBe("rejected");
	// Closing acknowledges abandonment immediately; the old worker releases its lock before it exits.
	await vi.waitFor(() => expect(fs.existsSync(`${archiveFile()}.lock`)).toBe(false), { interval: 5, timeout: 5000 });
	expect(history.rowsBefore(agent.db, "config_audits", NOW, 5001)).toHaveLength(5000);
	expect(fs.existsSync(archiveFile())).toBe(false);
	writer = new DbWriter(locations());
	expect(await writer.archive(NOW, DEFAULT_HISTORY_WINDOWS)).toEqual({ archived: 5000, deleted: 5000 });
	expect(remaining()).toHaveLength(0);
	expect(gunzipSync(fs.readFileSync(archiveFile())).toString().trim().split("\n")).toHaveLength(5000);
});
