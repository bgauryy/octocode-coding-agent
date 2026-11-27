import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendArchive, trimArchive, type ArchiveRecord } from "../src/history-archive.ts";
import { ArchiveDamagedError, memberHeads } from "../src/history-member.ts";
import { tmp } from "./helpers.ts";

const NOW = Date.UTC(2026, 10, 15, 12);
const MONTH_AT = Date.UTC(2026, 10, 2);
const KEEP = 30 * 86_400_000;
let dir: string;
let file: string;

const record = (n: number, detail = "x"): ArchiveRecord => ({
	db: "db",
	id: String(n),
	at: MONTH_AT + n * 100,
	row: { id: n + 1, at: MONTH_AT + n * 100, detail: `${detail} ${n} ${"lorem ipsum ".repeat(10)}` },
});
const batch = (from: number, count: number) => Array.from({ length: count }, (_, i) => record(from + i));
const lines = (data: Buffer) =>
	data
		.toString()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ArchiveRecord);
const stored = () => lines(zlib.gunzipSync(fs.readFileSync(file)));
const heads = () => {
	const fd = fs.openSync(file, "r");
	try {
		return [...memberHeads(fd, fs.fstatSync(fd).size, file)];
	} finally {
		fs.closeSync(fd);
	}
};
const write = (records: ArchiveRecord[]) => appendArchive(dir, "audits", records, NOW, KEEP);

beforeEach(() => {
	dir = tmp();
	file = path.join(dir, "audits-2026-11.jsonl.gz");
});
afterEach(() => vi.restoreAllMocks());

it("refuses a month without member headers, leaving it as it was", () => {
	const bytes = zlib.gzipSync(
		batch(0, 3)
			.map((r) => `${JSON.stringify(r)}\n`)
			.join(""),
	);
	fs.writeFileSync(file, bytes);
	expect(() => write(batch(3, 2))).toThrow(ArchiveDamagedError);
	expect(fs.readFileSync(file)).toEqual(bytes);
	expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

it("bounds a large month's write to the new rows plus one raw copy, however many rows it holds", () => {
	for (let from = 0; from < 120_000; from += 5000) write(batch(from, 5000));
	expect(heads().length).toBe(24);
	const inflate = vi.spyOn(zlib, "gunzipSync");
	const deflate = vi.spyOn(zlib, "gzipSync");
	const before = fs.statSync(file).size;
	const next = batch(120_000, 5000);
	write(next);
	const newText = next.map((r) => `${JSON.stringify(r)}\n`).join("").length;
	// One member compressed, no member inflated beyond one batch's size, the rest copied as bytes.
	expect(deflate).toHaveBeenCalledTimes(1);
	expect(String(deflate.mock.calls[0][0]).length).toBeLessThanOrEqual(newText);
	const widest = Math.max(...inflate.mock.results.map((r) => (r.type === "return" ? (r.value as Buffer).length : 0)));
	expect(widest).toBeLessThanOrEqual(newText);
	expect(fs.statSync(file).size).toBeGreaterThan(before);
	expect(stored()).toHaveLength(125_000);
	// A replay of the same batch settles against the stored rows without rewriting.
	const stat = fs.statSync(file, { bigint: true });
	deflate.mockClear();
	write(next);
	expect(deflate).not.toHaveBeenCalled();
	expect(fs.statSync(file, { bigint: true }).ino).toBe(stat.ino);
}, 60_000);

it("replaces a record that carries the same database and id, in place", () => {
	write(batch(0, 10));
	write(batch(10, 10));
	write([record(3, "changed"), record(25)]);
	const rows = stored();
	expect(rows).toHaveLength(21);
	expect(rows.filter((r) => r.id === "3")).toEqual([record(3, "changed")]);
});

it("folds small tail members together so single-row writes do not pile up members", () => {
	for (let n = 0; n < 20; n++) write([record(n)]);
	expect(heads().map((h) => h.rows)).toEqual([20]);
	expect(stored()).toEqual(batch(0, 20));
});

it.each(["before-rename", "after-rename"])("replays a write interrupted %s without loss or duplicates", (stage) => {
	write(batch(0, 4));
	const old = fs.readFileSync(file);
	const rename = fs.renameSync;
	vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
		if (stage === "before-rename") throw new Error("interrupted");
		rename(from, to);
		throw new Error("interrupted");
	});
	expect(() => write(batch(4, 3))).toThrow("interrupted");
	vi.restoreAllMocks();
	if (stage === "before-rename") expect(fs.readFileSync(file)).toEqual(old);
	expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
	write(batch(4, 3));
	expect(stored()).toEqual(batch(0, 7));
});

it("refuses a month whose last member is cut short, leaving it as it was", () => {
	write(batch(0, 10));
	write(batch(10, 10));
	const cut = fs.readFileSync(file).subarray(0, -7);
	fs.writeFileSync(file, cut);
	expect(() => write(batch(20, 1))).toThrow(ArchiveDamagedError);
	expect(fs.readFileSync(file)).toEqual(cut);
});

it("refuses a member whose header row count does not match its content", () => {
	write(batch(0, 5));
	write([record(5)]);
	const bytes = fs.readFileSync(file);
	const [first] = heads();
	// The row count sits after the 10-byte gzip header, XLEN, the 4-byte subfield header and the 4-byte length.
	bytes.writeUInt32LE(first.rows + 1, first.offset + 10 + 2 + 4 + 4);
	fs.writeFileSync(file, bytes);
	expect(() => write([record(6)])).toThrow(ArchiveDamagedError);
	expect(fs.readFileSync(file)).toEqual(bytes);
});

it("trims a month by member: expired members are dropped uninflated, a straddling one is filtered", () => {
	const day = 86_400_000;
	const at = (n: number, days: number): ArchiveRecord => ({ ...record(n), at: MONTH_AT + days * day + n });
	// Four members of 3000 rows (not small enough to fold): two expired, one live, one straddling the floor.
	write(Array.from({ length: 3000 }, (_, i) => at(i, 0)));
	write(Array.from({ length: 3000 }, (_, i) => at(3000 + i, 1)));
	write(Array.from({ length: 3000 }, (_, i) => at(6000 + i, 20)));
	write(Array.from({ length: 3000 }, (_, i) => at(9000 + i, i % 2 ? 0 : 21)));
	expect(heads().map((h) => h.rows)).toEqual([3000, 3000, 3000, 3000]);
	const all = stored();
	const floor = MONTH_AT + 5 * day;
	const inflate = vi.spyOn(zlib, "gunzipSync");
	trimArchive(dir, floor + KEEP, KEEP);
	const inflated = inflate.mock.calls.length;
	const after = stored();
	expect(after.map((r) => r.id).sort()).toEqual(
		all
			.filter((r) => r.at >= floor)
			.map((r) => r.id)
			.sort(),
	);
	expect(after).toHaveLength(4500);
	// The expired members were never inflated and the live one was copied as bytes: only the straddling member was.
	expect(inflated).toBe(1);
	expect(heads().map((h) => h.rows)).toEqual([3000, 1500]);
});
