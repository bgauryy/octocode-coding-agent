import fs from "node:fs/promises";
import { constants } from "node:fs";
import { scanLines, type ScanQuery } from "./analyze.ts";
import { addFile, type FirstPass } from "./score.ts";

/** A file to rank: its path and the label its header boost reads. */
export interface RankFile {
	file: string;
	label: string;
}

/** The lines a `query` filter matched, by file index. */
export type Filtered = ReadonlyMap<number, ReadonlySet<number>>;

function matchesWithin(matched: ReadonlySet<number> | undefined, start: number, end: number): boolean {
	if (!matched) return false;
	for (let at = start; at <= end; at++) if (matched.has(at)) return true;
	return false;
}

/** `file` as text with its stamp (size, mtime, inode), or undefined when it is gone, not a regular file or a link. */
async function readText(file: string): Promise<{ text: string; stamp: string } | undefined> {
	try {
		const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await handle.stat();
			if (!stat.isFile()) return undefined;
			return { text: await handle.readFile("utf8"), stamp: `${stat.size}:${stat.mtimeMs}:${stat.ino}` };
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code) return undefined;
		throw error;
	}
}

/**
 * Reads and scans each of `files` at `indexes` (all when omitted) into `pass`, one at a time; `check` runs between
 * files and inside long ones (cancellation, yielding).
 */
export async function scanFiles(
	pass: FirstPass,
	files: readonly RankFile[],
	query: ScanQuery,
	filtered: Filtered | undefined,
	check: () => void | Promise<void>,
	indexes: Iterable<number> = files.keys(),
): Promise<void> {
	for (const index of indexes) {
		await check();
		const read = await readText(files[index].file);
		if (!read) continue;
		const keep = filtered ? (start: number, end: number) => matchesWithin(filtered.get(index), start, end) : undefined;
		const scan = await scanLines(files[index].file, read.text.split("\n"), query, keep, check);
		addFile(pass, query, index, files[index].label, read.stamp, scan);
	}
}
