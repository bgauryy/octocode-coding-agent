import { Worker } from "node:worker_threads";
import { SCAN_WORKER } from "./history-search-worker.ts";

/** The text a search of strings already in memory (`matchTexts`) accepts, in total. */
export const HISTORY_BYTES = 32 * 1024 * 1024;
/** The worker stops its scan at a line boundary after this long, and says where to resume. */
const SCAN_BUDGET_MS = 3_000;
/** A regex still running this long (backtracking inside one line) is stopped and the search fails. */
const SEARCH_TIMEOUT_MS = 5_000;
/** A line longer than this is skipped, not tested: one such line must not hold a whole file in memory. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** A context line longer than this is reported by its length. */
const CONTEXT_LINE_CHARS = 400;

/** Where a scan stopped: the file (index in the scanned list), the byte offset of the next line and its 0-based index. */
export interface ScanPosition {
	file: number;
	offset: number;
	line: number;
}

interface HistoryMatches {
	/** The file's index in the scanned list. */
	index: number;
	/** The 0-based lines that matched. */
	matched: number[];
	/** The matched lines' text and the context lines around them, by 0-based line; a context line over `CONTEXT_LINE_CHARS` is its length. */
	lines: Record<number, string | number>;
}

export interface HistoryScan {
	results: HistoryMatches[];
	/** Files read to their end in this scan. */
	scanned: number;
	/** Where to resume; absent when every file was read to its end. */
	next?: ScanPosition;
	/** Files that could not be opened or are not regular files. */
	unreadable: number;
	/** Lines over the line limit, not tested. */
	skippedLines: number;
}

export interface ScanOptions {
	start?: ScanPosition;
	/** Stop after about this many matching lines (default: no limit). */
	maxMatches?: number;
	/** Lines kept around each match (default 0). */
	context?: number;
	/** Soft time budget in ms, for tests (default `SCAN_BUDGET_MS`). */
	budgetMs?: number;
}

/**
 * Scan `files` in order for lines `pattern` matches, in a worker (filesystem reads and backtracking regexes stay off the
 * agent's event loop; an abort terminates it). The scan is bounded by matches and time, not by corpus size: it returns
 * what it found and where to resume (`next`).
 */
export async function scanHistory(
	files: readonly string[],
	pattern: RegExp,
	signal?: AbortSignal,
	options: ScanOptions = {},
): Promise<HistoryScan> {
	signal?.throwIfAborted();
	const empty: HistoryScan = { results: [], scanned: 0, unreadable: 0, skippedLines: 0 };
	if (files.length === 0) return empty;
	return run(
		{
			files,
			start: options.start ?? { file: 0, offset: 0, line: 0 },
			context: options.context ?? 0,
			maxMatches: options.maxMatches ?? Number.MAX_SAFE_INTEGER,
			softMs: options.budgetMs ?? SCAN_BUDGET_MS,
			maxLineBytes: MAX_LINE_BYTES,
			longContext: CONTEXT_LINE_CHARS,
		},
		pattern,
		signal,
	);
}

/** The cursor text for `next`; it names the file by path so it survives a changed list. */
export function scanCursor(files: readonly string[], next: ScanPosition): string {
	return `h1.${Buffer.from(JSON.stringify({ f: files[next.file], o: next.offset, l: next.line })).toString("base64url")}`;
}

/** Whether `cursor` continues a session-history scan (`scanCursor`) rather than a record listing. */
export const isScanCursor = (cursor: string | undefined): cursor is string => cursor?.startsWith("h1.") === true;

/** The position `cursor` names in `files`. */
export function scanResume(files: readonly string[], cursor: string): ScanPosition {
	try {
		const { f, o, l } = JSON.parse(Buffer.from(cursor.slice(3), "base64url").toString("utf8")) as {
			f: string;
			o: number;
			l: number;
		};
		const file = files.indexOf(f);
		if (file >= 0 && Number.isSafeInteger(o) && Number.isSafeInteger(l) && o >= 0 && l >= 0)
			return { file, offset: o, line: l };
	} catch {
		// Falls through to the error below.
	}
	throw new Error("cursor does not continue this search: repeat the search without a cursor, or with the same file.");
}

/**
 * The indices of `texts` that `pattern` matches, tested in the same worker, for text already in memory (the `archive`
 * tool's error results).
 */
export async function matchTexts(
	texts: readonly string[],
	pattern: RegExp,
	signal?: AbortSignal,
): Promise<Set<number>> {
	signal?.throwIfAborted();
	if (texts.length === 0) return new Set();
	if (texts.reduce((sum, text) => sum + text.length, 0) > HISTORY_BYTES)
		throw new Error("archive search exceeds 32 MiB of text; narrow file to a session folder or add since.");
	const { results } = await run({ texts }, pattern, signal);
	return new Set(results[0]?.matched);
}

async function run(
	input: Record<string, unknown>,
	pattern: RegExp,
	signal: AbortSignal | undefined,
): Promise<HistoryScan> {
	const worker = new Worker(SCAN_WORKER, {
		eval: true,
		execArgv: [],
		workerData: { ...input, pattern: pattern.source, flags: pattern.flags.replace("g", "") },
		resourceLimits: { maxOldGenerationSizeMb: 256 },
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	try {
		return await new Promise<HistoryScan>((resolve, reject) => {
			abort = () => reject(signal?.reason ?? new Error("Archive search aborted."));
			signal?.addEventListener("abort", abort, { once: true });
			timer = setTimeout(
				() =>
					reject(
						new Error(
							"Archive search exceeded 5 seconds; simplify query (nested quantifiers backtrack inside one line) or narrow file to a session folder or one archive file.",
						),
					),
				SEARCH_TIMEOUT_MS,
			);
			worker.on("message", (message: { type?: string; error?: string } & Partial<HistoryScan>) => {
				if (message?.type !== "octocode-history-matches") return;
				if (message.error) reject(new Error(message.error));
				else
					resolve({
						results: message.results ?? [],
						scanned: message.scanned ?? 0,
						...(message.next ? { next: message.next } : {}),
						unreadable: message.unreadable ?? 0,
						skippedLines: message.skippedLines ?? 0,
					});
			});
			worker.once("error", reject);
			worker.once("exit", (code) =>
				reject(new Error(`Archive search worker exited before returning results (code ${code}).`)),
			);
			if (signal?.aborted) abort();
		});
	} finally {
		clearTimeout(timer);
		if (abort) signal?.removeEventListener("abort", abort);
		await worker.terminate();
	}
}
