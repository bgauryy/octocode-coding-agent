import { closeSync, copyFileSync, existsSync, fstatSync, openSync, readSync, truncateSync } from "fs";
import { resolvePath } from "../../utils/paths.ts";
import { withSessionFileLock } from "./shared-file.ts";

/** What `repairSessionFile` changed. */
export interface SessionRepair {
	/** The session file that was truncated. */
	file: string;
	/** Copy of the file as it was before the repair. */
	backup: string;
	/** Bytes of the torn final record that were cut off. */
	removedBytes: number;
}

/** First free `<file>.bak`, `<file>.1.bak`, ...: an earlier backup is never overwritten. */
function backupPath(file: string): string {
	let backup = `${file}.bak`;
	for (let n = 1; existsSync(backup); n++) backup = `${file}.${n}.bak`;
	return backup;
}

/** Offset just past the last newline of `fd` (0 when there is none), reading backwards in blocks. */
function endOfLastRecord(fd: number, size: number): number {
	const block = Buffer.alloc(64 * 1024);
	for (let end = size; end > 0;) {
		const start = Math.max(0, end - block.length);
		const read = readSync(fd, block, 0, end - start, start);
		const at = block.subarray(0, read).lastIndexOf(10);
		if (at >= 0) return start + at + 1;
		end = start;
	}
	return 0;
}

/**
 * Repairs a session file whose final record is torn (power loss, ENOSPC mid-append: the last byte is not a newline).
 * Copies the file to a `.bak` beside it, then truncates it to the last complete line. Returns undefined when the tail
 * is already complete. A file with no complete line at all is refused: there is nothing to keep.
 */
export function repairSessionFile(sessionFile: string): SessionRepair | undefined {
	const file = resolvePath(sessionFile);
	return withSessionFileLock(file, () => {
		const fd = openSync(file, "r");
		let size: number;
		let keep: number;
		try {
			size = fstatSync(fd).size;
			const last = Buffer.alloc(1);
			if (size === 0 || (readSync(fd, last, 0, 1, size - 1) === 1 && last[0] === 10)) return undefined;
			keep = endOfLastRecord(fd, size);
		} finally {
			closeSync(fd);
		}
		if (keep === 0) throw new Error(`Session file has no complete record to keep: ${file}`);
		const backup = backupPath(file);
		copyFileSync(file, backup);
		truncateSync(file, keep);
		return { file, backup, removedBytes: size - keep };
	});
}
