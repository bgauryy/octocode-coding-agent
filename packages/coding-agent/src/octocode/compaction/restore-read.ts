import fs from "node:fs";

/** Reading a file back after a compaction (`restore.ts`): its text when it is a small UTF-8 text file, and its stamp. */

/** Files larger than this are never read back (a generated or data file is no working context, and reading it costs time). */
export const RESTORE_MAX_BYTES = 2_000_000;

/** How much of a file is looked at before the rest is read: binary data shows in its first bytes. */
const SNIFF_BYTES = 8_192;

/**
 * The text of `file` when it is a small UTF-8 text file, else undefined. The first `SNIFF_BYTES` are checked (no NUL,
 * valid UTF-8) before the whole file is read, so a large binary file costs one small read.
 */
export function textOf(file: string): { text: string; stamp: Stamp } | undefined {
	try {
		// `stat` first: opening a FIFO or device would block.
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > RESTORE_MAX_BYTES) return undefined;
		const fd = fs.openSync(file, "r");
		try {
			const head = Buffer.alloc(Math.min(stat.size, SNIFF_BYTES));
			const read = fs.readSync(fd, head, 0, head.length, 0);
			const sniffed = head.subarray(0, read);
			// `stream`: a character cut by the end of the sniffed bytes is not an error.
			if (sniffed.includes(0) || !isUtf8(sniffed)) return undefined;
			const text = fs.readFileSync(fd, "utf8");
			return text.includes("\uFFFD") ? undefined : { text, stamp: stampOf(stat) };
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

/** Whether `head`, the start of a file, is UTF-8 up to a character cut by its end. */
function isUtf8(head: Uint8Array): boolean {
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
		return true;
	} catch {
		return false;
	}
}

/** What a file was on disk when it was read back: a later stat that differs means the model's copy is stale. */
export interface Stamp {
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	ino: number;
}

const stampOf = ({ mtimeMs, ctimeMs, size, ino }: Stamp): Stamp => ({ mtimeMs, ctimeMs, size, ino });

export function sameStamp(file: string, stamp: Stamp): boolean {
	try {
		const now = fs.statSync(file);
		return (
			now.mtimeMs === stamp.mtimeMs && now.ctimeMs === stamp.ctimeMs && now.size === stamp.size && now.ino === stamp.ino
		);
	} catch {
		return false;
	}
}
