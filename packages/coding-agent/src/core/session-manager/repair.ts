import { closeSync, constants, copyFileSync, existsSync, fstatSync, openSync, readSync, truncateSync } from "node:fs";
import { resolvePath } from "../../../../common/src/paths.ts";
import { withSessionFileLock } from "./shared-file.ts";
import { endOfLastRecord } from "./session-tail.ts";

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

/** Copy the file as it is to the first free backup name and return that name; an existing backup is never replaced. */
export function backupSessionFile(file: string): string {
	const backup = backupPath(file);
	copyFileSync(file, backup, constants.COPYFILE_EXCL);
	return backup;
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
		const backup = backupSessionFile(file);
		truncateSync(file, keep);
		return { file, backup, removedBytes: size - keep };
	});
}
