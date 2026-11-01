import fs from "node:fs";

/** Output tail a finished job reports back; the report counts the lines before it and names the log that holds them. */
export const TAIL_BYTES = 4 * 1024;
const TAIL_LINES = 40;

/** Lines in `fd` (a last line without a newline counts too), read in 1 MB chunks. */
function countLines(fd: number, size: number): number {
	const chunk = Buffer.alloc(Math.min(size, 1024 * 1024));
	let lines = 0;
	let last = 0x0a;
	for (let position = 0; position < size;) {
		const read = fs.readSync(fd, chunk, 0, chunk.length, position);
		if (read <= 0) break;
		for (let at = chunk.indexOf(0x0a); at !== -1 && at < read; at = chunk.indexOf(0x0a, at + 1)) lines++;
		last = chunk[read - 1]!;
		position += read;
	}
	return last === 0x0a ? lines : lines + 1;
}

/**
 * The end of a job's log: its last whole lines, at most `maxLines` within `maxBytes`, and how many lines come before
 * them (they stay in the log; a rotated log names its `.1` file on its first line). The job report shows this tail and
 * the verification receipt calls it incomplete exactly when it leaves lines out, so both read it here.
 */
export function logTail(file: string, maxBytes = TAIL_BYTES, maxLines = TAIL_LINES): { text: string; earlier: number } {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const size = fs.fstatSync(fd).size;
			const length = Math.min(size, maxBytes);
			const buffer = Buffer.alloc(length);
			fs.readSync(fd, buffer, 0, length, size - length);
			let text = buffer.toString("utf8");
			if (size > length) text = text.slice(text.indexOf("\n") + 1);
			const lines = text.split("\n");
			if (lines.at(-1) === "") lines.pop();
			const kept = lines.slice(-maxLines);
			return { text: kept.join("\n"), earlier: countLines(fd, size) - kept.length };
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return { text: "", earlier: 0 };
	}
}
