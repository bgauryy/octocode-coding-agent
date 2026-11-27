import fs from "node:fs";
import { type ArchiveIndexDb, archiveIndex, openArchiveIndex } from "../../../../../db/src/api.ts";
import { analyzeLines } from "../rank/analyze.ts";
import { TOKENIZER_VERSION } from "../rank/terms.ts";

/**
 * Keeps the archive index level with the archive files: each file is indexed again only when its size, mtime or inode
 * moved, one transaction per file, so a sync stopped between files leaves every stored file whole.
 */

/** Opens the index at `file`; a tokenizer other than this one's empties it first. */
export function openIndex(file: string): ArchiveIndexDb {
	const index = openArchiveIndex(file);
	if (index.fts && archiveIndex.readMeta(index.db, "tokenizer") !== String(TOKENIZER_VERSION))
		index.transaction(() => {
			archiveIndex.clear(index.db);
			archiveIndex.writeMeta(index.db, "tokenizer", String(TOKENIZER_VERSION));
		});
	return index;
}

const stampOf = (stat: { size: number; mtimeMs: number; ino: number }) => `${stat.size}:${stat.mtimeMs}:${stat.ino}`;

/** A file the index holds at its current stamp. */
interface Current {
	id: number;
	stamp: string;
	passages: number;
	words: number;
}

function regularStat(file: string): fs.Stats | undefined {
	try {
		const stat = fs.lstatSync(file);
		return stat.isFile() ? stat : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code) return undefined;
		throw error;
	}
}

/**
 * Reads and indexes `file` at `stat`; undefined when it changed or went away meanwhile (it stays unindexed). `poll` runs
 * after the read, after the analysis and between batches of rows: a throw from it stops the work, and the transaction
 * leaves the index holding the file as it was.
 */
function indexFile(
	index: ArchiveIndexDb,
	file: string,
	stat: fs.Stats,
	poll: () => void,
): archiveIndex.IndexedFile | undefined {
	let text: string;
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
		const opened = fs.fstatSync(fd);
		if (!opened.isFile() || stampOf(opened) !== stampOf(stat)) return undefined;
		text = fs.readFileSync(fd, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code) return undefined;
		throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	poll();
	const passages = analyzeLines(file, text.split("\n")).map(({ context, ...passage }) => ({
		...passage,
		context: context ? JSON.stringify(context) : null,
	}));
	poll();
	return index.transaction(() =>
		archiveIndex.replaceFile(
			index.db,
			{ path: file, size: stat.size, mtime: stat.mtimeMs, ino: stat.ino },
			passages,
			poll,
		),
	);
}

export interface SyncResult {
	/** Files of the list the index holds at their current stamp, by path. */
	current: Map<string, Current>;
	/** Files of the list on disk that the index does not hold (past the budget, or changing while read). */
	pending: string[];
}

/**
 * Brings the index level with `paths`: files gone from disk lose their rows, changed and new ones are indexed until
 * `budgetBytes` of them have been read (the rest stay pending). `check` runs between files and `poll` inside one, so a
 * long file does not hold a cancellation back: either may throw to stop.
 */
export async function syncFiles(
	index: ArchiveIndexDb,
	paths: readonly string[],
	check: () => void | Promise<void>,
	budgetBytes = Number.POSITIVE_INFINITY,
	poll: () => void = () => undefined,
): Promise<SyncResult> {
	const known = new Map(archiveIndex.files(index.db).map((row) => [row.path, row]));
	const current = new Map<string, Current>();
	const stale: Array<{ file: string; stat: fs.Stats }> = [];
	const gone: string[] = [];
	for (const file of new Set(paths)) {
		const stat = regularStat(file);
		const row = known.get(file);
		if (!stat) {
			if (row) gone.push(file);
			continue;
		}
		if (row && row.size === stat.size && row.mtime === stat.mtimeMs && row.ino === stat.ino)
			current.set(file, { id: row.id, stamp: stampOf(stat), passages: row.passages, words: row.words });
		else stale.push({ file, stat });
	}
	if (gone.length > 0) index.transaction(() => archiveIndex.deleteFiles(index.db, gone));
	const pending: string[] = [];
	let spent = 0;
	for (const { file, stat } of stale) {
		if (spent >= budgetBytes) {
			pending.push(file);
			continue;
		}
		await check();
		spent += stat.size;
		const row = indexFile(index, file, stat, poll);
		if (!row) {
			pending.push(file);
			continue;
		}
		current.set(file, { id: row.id, stamp: stampOf(stat), passages: row.passages, words: row.words });
	}
	return { current, pending };
}

/** Removes the rows of every indexed file no longer on disk (files of sessions deleted since). */
export function pruneMissing(index: ArchiveIndexDb): void {
	const gone = archiveIndex
		.files(index.db)
		.filter((row) => !regularStat(row.path))
		.map((row) => row.path);
	if (gone.length > 0) index.transaction(() => archiveIndex.deleteFiles(index.db, gone));
}
