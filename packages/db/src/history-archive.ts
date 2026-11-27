import fs from "node:fs";
import path from "node:path";
import { sha256 } from "../../common/src/atomic-file.ts";
import { withFileLockSync } from "../../common/src/file-write-lock.ts";
import type { AgentDb } from "./db.ts";
import { privateDir } from "../../common/src/file-mode.ts";
import { canonicalPath } from "../../common/src/canonical-path.ts";
import { DAY_MS } from "../../common/src/time.ts";
import type { ArchiveRecord, ArchiveRow } from "./history-record.ts";
import { cachedMonth, monthFiles, pruneMonthCache } from "./history-month.ts";
import { rewriteMonth } from "./history-rewrite.ts";
import { auditSelection } from "./history-selection.ts";
export type { ArchiveRecord, ArchiveRow } from "./history-record.ts";

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

/** A bounded audit read: selection happens beside the archive, before rows cross the worker boundary. */
export interface ArchiveAuditQuery {
	now: number;
	repo: string;
	ref?: string;
	before?: number;
	limit: number;
	windows: HistoryWindows;
}

/**
 * The archive name of a database: a digest of the canonical path of its history source (`AgentDb.historySource`: the
 * file itself, or for a workspace file the machine file its rows came from, so one repository's history stays one stream).
 */
export const archiveSource = (agentDb: Pick<AgentDb, "historySource">): string =>
	sha256(canonicalPath(agentDb.historySource)).slice(0, 16);

/** `<dir>/<family>-YYYY-MM.jsonl.gz` for the UTC month of `at`. */
const monthFile = (dir: string, family: Family, at: number) =>
	path.join(dir, `${family}-${new Date(at).toISOString().slice(0, 7)}.jsonl.gz`);

/** Adds `records` of `family` to their month files under `dir` (created owner-only). */
export function appendArchive(
	dir: string,
	family: Family,
	records: readonly ArchiveRecord[],
	now: number,
	keepMs: number,
	assertActive: () => void = () => {},
): void {
	if (records.length === 0) return;
	privateDir(dir);
	const byMonth = new Map<string, ArchiveRecord[]>();
	for (const record of records) {
		const file = monthFile(dir, family, record.at);
		(byMonth.get(file) ?? byMonth.set(file, []).get(file)!).push(record);
	}
	for (const [file, month] of byMonth) rewriteMonth(file, month, now, keepMs, assertActive);
}

/** Drops archived rows older than the keep window: whole months past it are removed, a month that straddles it is rewritten. */
export function trimArchive(dir: string, now: number, keepMs: number, assertActive: () => void = () => {}): void {
	const floor = now - keepMs;
	for (const { file, start, end } of monthFiles(dir)) {
		assertActive();
		if (end <= floor)
			withFileLockSync(
				file,
				(assertHeld) => {
					assertActive();
					assertHeld();
					fs.rmSync(file, { force: true });
				},
				{ attempts: 1 },
			);
		else if (start < floor) rewriteMonth(file, [], now, keepMs, assertActive);
	}
}

/**
 * The archived `backlog_audits` rows of `agentDb` within the keep window, as stored: repository `repo`, item `ref` when
 * set, ids below `before` when set; the newest `limit`, newest first. `windows` is the keep window housekeeping used.
 */
export function archivedAudits(
	agentDb: Pick<AgentDb, "historySource" | "archiveDir">,
	now: number,
	repo: string,
	ref: string | undefined,
	before: number | undefined,
	limit: number,
	windows: HistoryWindows = DEFAULT_HISTORY_WINDOWS,
): ArchiveRow[] {
	const floor = now - windowsMs(windows).keepMs;
	const files = monthFiles(agentDb.archiveDir, "audits").filter((month) => month.end > floor);
	pruneMonthCache(
		agentDb.archiveDir,
		files.map((month) => month.file),
	);
	if (files.length === 0) return [];
	const selection = auditSelection(archiveSource(agentDb), floor, repo, ref, before, limit);
	for (const { file } of files) for (const record of readableMonth(file)) selection.accept(record);
	return selection.rows;
}

/** One month's records for a read; a damaged month is skipped (writers refuse it too) so the other months still load. */
function readableMonth(file: string): ArchiveRecord[] {
	try {
		return cachedMonth(file);
	} catch {
		return [];
	}
}
