/**
 * Cost of one monthly archive write as the month grows (B95, B945). The write runs inside the DbWriter worker, so the
 * numbers are the writer queue's stall and the memory and disk the worker spends, not session event-loop time.
 *   node packages/db/scripts/bench-archive.ts [existingRows...]     default: 5000 20000 100000 400000
 * Each size seeds a month as one legacy gzip member (the shape older builds wrote), then appends two batches of 5000
 * rows, each write in its own process so its peak is its alone: `legacyMonth` is the first write to that month and
 * `nextAppend` the steady state. Prints CPU ms (user+system) beside wall ms, peak RSS growth over the process baseline,
 * `amplification` (bytes written divided by the new batch's encoded bytes), and the file size.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { appendArchive, type ArchiveRecord } from "../src/history-archive.ts";

const NOW = Date.UTC(2026, 10, 15, 12);
const MONTH_AT = Date.UTC(2026, 10, 2);
const BATCH = 5000;
const DAY = 86_400_000;

const record = (n: number): ArchiveRecord => ({
	db: "bench",
	id: String(n),
	at: MONTH_AT + n * 100,
	row: {
		id: n + 1,
		at: MONTH_AT + n * 100,
		repo: "octocode/octocodecode",
		ref: `B${n % 900}`,
		actor: "agent",
		action: "note",
		detail: `row ${n} ${"lorem ipsum dolor sit amet ".repeat(8)}`,
	},
});
const cpu = () => {
	const u = process.cpuUsage();
	return (u.user + u.system) / 1000;
};

/** Seeds a legacy month of `existing` rows (streamed, so the seed itself stays small). */
function seed(dir: string, existing: number): Promise<void> {
	const deflate = zlib.createGzip();
	const chunks: Buffer[] = [];
	deflate.on("data", (chunk: Buffer) => chunks.push(chunk));
	for (let n = 0; n < existing; n++) deflate.write(`${JSON.stringify(record(n))}\n`);
	deflate.end();
	return new Promise((resolve) =>
		deflate.once("end", () => {
			fs.writeFileSync(path.join(dir, "audits-2026-11.jsonl.gz"), Buffer.concat(chunks), { mode: 0o600 });
			resolve();
		}),
	);
}

/** One append of `BATCH` rows after `offset` existing ones, measured; the process holds nothing else but the batch. */
function measure(dir: string, existing: number, offset: number, label: string): void {
	const file = path.join(dir, "audits-2026-11.jsonl.gz");
	const batch = Array.from({ length: BATCH }, (_, i) => record(offset + i));
	const encoded = zlib.gzipSync(batch.map((r) => `${JSON.stringify(r)}\n`).join("")).length;
	let written = 0;
	const writeSync = fs.writeSync as (...args: unknown[]) => number;
	(fs as unknown as Record<string, unknown>).writeSync = (...args: unknown[]) => {
		const length = writeSync(...args);
		written += length;
		return length;
	};
	global.gc?.();
	const rss0 = process.resourceUsage().maxRSS;
	const c0 = cpu();
	const t0 = performance.now();
	appendArchive(dir, "audits", batch, NOW, 30 * DAY);
	const wall = performance.now() - t0;
	console.log(
		JSON.stringify({
			existingRows: existing,
			write: label,
			fileKB: Math.round(fs.statSync(file).size / 1024),
			cpuMs: Math.round(cpu() - c0),
			wallMs: Math.round(wall),
			peakRssGrowthMB: Math.round((process.resourceUsage().maxRSS - rss0) / 1024),
			writtenKB: Math.round(written / 1024),
			amplification: Number((written / encoded).toFixed(1)),
			load1: os.loadavg()[0].toFixed(1),
		}),
	);
}

const [step, dir, rows] = [
	process.env.BENCH_ARCHIVE_STEP,
	process.env.BENCH_ARCHIVE_DIR ?? "",
	Number(process.env.BENCH_ARCHIVE_ROWS),
];
if (step === "seed") await seed(dir, rows);
else if (step === "legacyMonth") measure(dir, rows, rows, step);
else if (step === "nextAppend") measure(dir, rows, rows + BATCH, step);
else
	for (const size of process.argv.length > 2 ? process.argv.slice(2) : ["5000", "20000", "100000", "400000"]) {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "bench-archive-"));
		// Every step is its own process, so each peak is that write's alone.
		for (const next of ["seed", "legacyMonth", "nextAppend"]) {
			const run = spawnSync(process.execPath, [...process.execArgv, process.argv[1]], {
				env: { ...process.env, BENCH_ARCHIVE_STEP: next, BENCH_ARCHIVE_DIR: home, BENCH_ARCHIVE_ROWS: size },
				stdio: "inherit",
			});
			if (run.status !== 0) throw new Error(`bench ${next} for ${size} rows exited with ${String(run.status)}`);
		}
		fs.rmSync(home, { recursive: true, force: true });
	}
