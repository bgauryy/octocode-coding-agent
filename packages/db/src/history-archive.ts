import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { atomicWriteFileSync, sha256 } from "../../common/src/atomic-file.ts";
import { withFileLockSync } from "../../common/src/file-write-lock.ts";
import type { AgentDb } from "./db.ts";
import { privateDir } from "../../common/src/file-mode.ts";
import { canonicalPath } from "../../common/src/canonical-path.ts";
import { DAY_MS } from "../../common/src/time.ts";

/**
 * How long history rows live: rows older than `archiveAfterDays` leave the database for the archive, and archived rows
 * older than `keepDays` are dropped (and never read back). `keepDays` 0 keeps archived rows forever. An
 * `archiveAfterDays` beyond a set `keepDays` is cut to it, so a short keep window is not stretched by the archive window.
 */
export interface HistoryWindows {
	archiveAfterDays: number;
	keepDays: number;
}

export const DEFAULT_HISTORY_WINDOWS: HistoryWindows = { archiveAfterDays: 14, keepDays: 30 };

/** The windows of `windows` in ms; `keepMs` is Infinity when `keepDays` is 0. Throws on a negative or non-finite value. */
export function windowsMs(windows: HistoryWindows = DEFAULT_HISTORY_WINDOWS): {
	archiveAfterMs: number;
	keepMs: number;
} {
	const { archiveAfterDays, keepDays } = windows;
	for (const days of [archiveAfterDays, keepDays])
		if (!Number.isFinite(days) || days < 0) throw new Error(`Invalid retention window: ${String(days)} days.`);
	const keepMs = keepDays === 0 ? Number.POSITIVE_INFINITY : keepDays * DAY_MS;
	return { archiveAfterMs: Math.min(archiveAfterDays * DAY_MS, keepMs), keepMs };
}

/** One archive family per history table: `audits` (backlog_audits), `config-audits`, `workspace-commands`. */
export type Family = "audits" | "config-audits" | "workspace-commands";

/**
 * One archived row: `db` names the database it came from (several databases may share one Octocode home, and their ids
 * collide), `id` is its key within that table, `at` when it was written, `row` every column as stored.
 */
export interface ArchiveRecord {
	db: string;
	id: string;
	at: number;
	row: ArchiveRow;
}

/** A history row's columns (text, integers or NULL; these tables hold no blobs). */
export type ArchiveRow = Record<string, string | number | null>;

const FILE = /^(audits|config-audits|workspace-commands)-(\d{4})-(\d{2})\.jsonl\.gz$/;

/** The archive name of a database: a digest of its canonical path. */
export const archiveSource = (agentDb: Pick<AgentDb, "file">): string =>
	sha256(canonicalPath(agentDb.file)).slice(0, 16);

/** `<dir>/<family>-YYYY-MM.jsonl.gz` for the UTC month of `at`. */
const monthFile = (dir: string, family: Family, at: number) =>
	path.join(dir, `${family}-${new Date(at).toISOString().slice(0, 7)}.jsonl.gz`);

/** The month files under `dir` (of `family` when set), with each month's UTC start and end. */
function monthFiles(dir: string, family?: Family): Array<{ file: string; start: number; end: number }> {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	return names.flatMap((name) => {
		const match = FILE.exec(name);
		if (!match || (family && match[1] !== family)) return [];
		const start = Date.UTC(Number(match[2]), Number(match[3]) - 1, 1);
		const end = Date.UTC(Number(match[2]), Number(match[3]), 1);
		return [{ file: path.join(dir, name), start, end }];
	});
}

/** The records of one month file, oldest first; none when it does not exist. A damaged file throws. */
function readMonth(file: string): ArchiveRecord[] {
	let data: Buffer;
	try {
		data = fs.readFileSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	return zlib
		.gunzipSync(data)
		.toString("utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ArchiveRecord);
}

/**
 * Rewrites one month file with `records` merged in, holding its lock (several Octocode processes may archive at once):
 * one record per database and id, or per receipt snapshot for mutable commands (a stale archiver must not replace a
 * newer receipt). Identical retries are kept once; no record outlives the keep window. Written atomically and owner-only
 * (the rows are as private as the database); a month left empty is removed.
 */
function rewriteMonth(file: string, records: readonly ArchiveRecord[], now: number, keepMs: number): void {
	withFileLockSync(file, (assertHeld) => {
		const merged = new Map<string, ArchiveRecord>();
		const receipts = path.basename(file).startsWith("workspace-commands-");
		for (const record of [...readMonth(file), ...records]) {
			const key = receipts ? [record.db, record.id, sha256(JSON.stringify(record.row))] : [record.db, record.id];
			merged.set(JSON.stringify(key), record);
		}
		const kept = [...merged.values()].filter((record) => record.at >= now - keepMs);
		kept.sort((a, b) => a.at - b.at);
		assertHeld();
		if (kept.length === 0) fs.rmSync(file, { force: true });
		else
			atomicWriteFileSync(file, zlib.gzipSync(kept.map((record) => `${JSON.stringify(record)}\n`).join("")), {
				mode: 0o600,
			});
	});
}

/** Adds `records` of `family` to their month files under `dir` (created owner-only). */
export function appendArchive(
	dir: string,
	family: Family,
	records: readonly ArchiveRecord[],
	now: number,
	keepMs: number,
): void {
	if (records.length === 0) return;
	privateDir(dir);
	const byMonth = new Map<string, ArchiveRecord[]>();
	for (const record of records) {
		const file = monthFile(dir, family, record.at);
		(byMonth.get(file) ?? byMonth.set(file, []).get(file)!).push(record);
	}
	for (const [file, month] of byMonth) rewriteMonth(file, month, now, keepMs);
}

/** Drops archived rows older than the keep window: whole months past it are removed, a month that straddles it is rewritten. */
export function trimArchive(dir: string, now: number, keepMs: number): void {
	const floor = now - keepMs;
	for (const { file, start, end } of monthFiles(dir)) {
		if (end <= floor) withFileLockSync(file, () => fs.rmSync(file, { force: true }));
		else if (start < floor && readMonth(file).some((record) => record.at < floor)) rewriteMonth(file, [], now, keepMs);
	}
}

/** Parsed month files by path, kept while the file is unchanged (a snapshot reads the audits of every item). */
const cache = new Map<string, { stamp: string; records: ArchiveRecord[] }>();

function cachedMonth(file: string): ArchiveRecord[] {
	const stat = fs.statSync(file, { throwIfNoEntry: false });
	if (!stat) {
		cache.delete(file);
		return [];
	}
	const stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
	const hit = cache.get(file);
	if (hit?.stamp === stamp) return hit.records;
	let records: ArchiveRecord[];
	try {
		records = readMonth(file);
	} catch {
		// A damaged or half-copied file: readers show the table alone; the writer refuses to overwrite it.
		records = [];
	}
	cache.set(file, { stamp, records });
	return records;
}

/**
 * The archived `backlog_audits` rows of `agentDb` within the keep window, as stored: repository `repo`, item `ref` when
 * set, ids below `before` when set; the newest `limit`, newest first. `windows` is the keep window housekeeping used.
 */
export function archivedAudits(
	agentDb: Pick<AgentDb, "file" | "archiveDir">,
	now: number,
	repo: string,
	ref: string | undefined,
	before: number | undefined,
	limit: number,
	windows: HistoryWindows = DEFAULT_HISTORY_WINDOWS,
): ArchiveRow[] {
	const floor = now - windowsMs(windows).keepMs;
	const files = monthFiles(agentDb.archiveDir, "audits").filter((month) => month.end > floor);
	for (const file of cache.keys()) if (!files.some((month) => month.file === file)) cache.delete(file);
	if (files.length === 0) return [];
	const source = archiveSource(agentDb);
	const rows = files.flatMap(({ file }) =>
		cachedMonth(file)
			.filter(
				(record) =>
					record.db === source &&
					record.at >= floor &&
					record.row.workspace_id === repo &&
					(ref === undefined || record.row.backlog_id === ref) &&
					(before === undefined || Number(record.row.id) < before),
			)
			.map((record) => record.row),
	);
	return rows.sort((a, b) => Number(b.id) - Number(a.id)).slice(0, limit);
}
