import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { archiveSource, archivedAudits, type ArchiveRecord } from "../src/history-archive.ts";
import { readArchivedAudits } from "../src/history-reader.ts";
import { tmp } from "./helpers.ts";

const NOW = Date.UTC(2026, 10, 15);
const AT = Date.UTC(2026, 9, 25);
const windows = { archiveAfterDays: 14, keepDays: 0 };
let agent: { file: string; archiveDir: string };
beforeEach(() => {
	const root = tmp();
	agent = { file: path.join(root, "agent.db"), archiveDir: path.join(root, "archive") };
	fs.mkdirSync(agent.archiveDir);
});
afterEach(() => vi.restoreAllMocks());
const record = (id: number, extra: object = {}): ArchiveRecord => ({
	db: archiveSource(agent),
	id: String(id),
	at: AT,
	row: { id, workspace_id: "ws", backlog_id: "B1", ...extra },
});
function write(records: ArchiveRecord[], month = "10"): string {
	const file = path.join(agent.archiveDir, `audits-2026-${month}.jsonl.gz`);
	fs.writeFileSync(file, zlib.gzipSync(records.map((row) => JSON.stringify(row) + "\n").join("")));
	return file;
}
const query = (limit = 3) => ({ now: NOW, repo: "ws", limit, windows });

it("selects newest ids across months and clock rollback with exact rows and filters", async () => {
	const rows = Array.from({ length: 100 }, (_, n) =>
		record(((n * 37) % 100) + 1, { backlog_id: n % 2 ? "B2" : "B1", payload: `row-${n}` }),
	);
	rows[3].db = "other-source";
	rows[4].row.workspace_id = "other-workspace";
	write(rows.slice(0, 50), "09");
	write(rows.slice(50));
	const input = { ...query(), ref: "B1", before: 70 };
	const expected = rows
		.filter(
			(r) =>
				r.db === archiveSource(agent) &&
				r.row.workspace_id === "ws" &&
				r.row.backlog_id === "B1" &&
				Number(r.row.id) < 70,
		)
		.map((r) => r.row)
		.sort((a, b) => Number(b.id) - Number(a.id))
		.slice(0, 3);
	expect(await readArchivedAudits(agent, input, () => {})).toEqual(expected);
	expect(archivedAudits(agent, NOW, "ws", "B1", 70, 3, windows)).toEqual(expected);
});

it("reuses a small validated month but does not retain months beyond the cache row budget", async () => {
	write([record(1)]);
	const decompress = vi.spyOn(zlib, "createGunzip");
	await readArchivedAudits(agent, query(), () => {});
	await readArchivedAudits(agent, query(), () => {});
	expect(decompress).toHaveBeenCalledTimes(1);
	write(Array.from({ length: 4200 }, (_, n) => record(n + 1)));
	decompress.mockClear();
	for (let n = 0; n < 2; n++)
		expect((await readArchivedAudits(agent, query(1), () => {})).map((row) => row.id)).toEqual([4200]);
	expect(decompress).toHaveBeenCalledTimes(2);
});

it("does not expose partial rows when the gzip trailer or a later record is corrupt", async () => {
	write([record(1)], "09");
	const file = write([record(2)]);
	const complete = fs.readFileSync(file);
	fs.writeFileSync(file, complete.subarray(0, -4));
	expect((await readArchivedAudits(agent, query(), () => {})).map((row) => row.id)).toEqual([1]);
	fs.writeFileSync(file, zlib.gzipSync(`${JSON.stringify(record(2))}\n${JSON.stringify({ missing: "envelope" })}\n`));
	expect((await readArchivedAudits(agent, query(), () => {})).map((row) => row.id)).toEqual([1]);
	fs.writeFileSync(file, complete);
	expect((await readArchivedAudits(agent, query(), () => {})).map((row) => row.id)).toEqual([2, 1]);
});

it("preserves Unicode records split across decompression chunks and concatenated gzip members", async () => {
	const rows = [record(1, { payload: "💾אב".repeat(10000) }), record(2)];
	const file = write([]);
	fs.writeFileSync(file, Buffer.concat(rows.map((r) => zlib.gzipSync(`${JSON.stringify(r)}\n`))));
	expect(await readArchivedAudits(agent, query(), () => {})).toEqual([rows[1].row, rows[0].row]);
});

it("checks cancellation while visiting records and does not return a partial selection", async () => {
	write(Array.from({ length: 100 }, (_, n) => record(n + 1)));
	let visits = 0;
	await expect(
		readArchivedAudits(agent, query(), () => {
			if (++visits >= 10) throw new Error("cancelled");
		}),
	).rejects.toThrow("cancelled");
	expect(visits).toBeLessThan(20);
	expect((await readArchivedAudits(agent, query(1), () => {})).map((row) => row.id)).toEqual([100]);
});

it.each(["bogus", null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
	"discards an audit month with invalid numeric ordering id %j without hiding another valid month",
	async (id) => {
		write([record(3)], "09");
		write([record(1), record(2, { id })]);
		expect(await readArchivedAudits(agent, query(10), () => {})).toEqual([record(3).row]);
		expect(archivedAudits(agent, NOW, "ws", undefined, undefined, 10, windows)).toEqual([record(3).row]);
	},
);

it("preserves numeric string audit ids while ordering them numerically", async () => {
	const rows = [record(1), record(2, { id: "2" })];
	write(rows);
	expect(await readArchivedAudits(agent, query(10), () => {})).toEqual([rows[1].row, rows[0].row]);
});
