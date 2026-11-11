import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/**
 * Reads a saved command output as callers that take more than the display receive it: the whole file, or past
 * `maxBytes` raw bytes its first and last `maxBytes / 2` bytes around an omission marker, cut at character boundaries.
 * `truncated` says the marker replaced part of it. Throws when the file cannot be read.
 */
export function readSavedOutput(path: string, maxBytes: number): { content: string; truncated: boolean } {
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		const read = (length: number, position: number) => {
			const buffer = Buffer.alloc(length);
			let done = 0;
			while (done < length) {
				const count = readSync(fd, buffer, done, length - done, position + done);
				if (count === 0) break;
				done += count;
			}
			return buffer.subarray(0, done);
		};
		if (size <= maxBytes) return { content: new TextDecoder().decode(read(size, 0)), truncated: false };
		const headBytes = Math.floor(maxBytes / 2);
		const tailBytes = maxBytes - headBytes;
		const tail = read(tailBytes, size - tailBytes);
		// Streaming decode holds back an incomplete trailing sequence, and the tail skips leading continuation bytes.
		const headText = new TextDecoder().decode(read(headBytes, 0), { stream: true });
		let tailStart = 0;
		while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart++;
		const tailText = new TextDecoder().decode(tail.subarray(tailStart));
		const omitted = size - headBytes - tailBytes;
		return { content: `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`, truncated: true };
	} finally {
		closeSync(fd);
	}
}
