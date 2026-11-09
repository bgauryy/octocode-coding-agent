/**
 * The archive-search worker's program, as inline JavaScript: it needs no source file or TypeScript loader in an installed
 * bundle. `search.ts` runs it and owns the message shapes.
 *
 * Files are read in 1 MiB chunks and tested line by line, so memory holds one chunk, one line and the matches, whatever
 * the file's size. The scan stops at a line boundary when it has `maxMatches` matching lines or `softMs` has passed, and
 * says where it stopped (`next`: file index, byte offset, line index) so a later scan resumes there. A line longer than
 * `maxLineBytes` is skipped and counted, not tested.
 */
export const SCAN_WORKER = String.raw`
const fs = require("node:fs");
const { parentPort, workerData } = require("node:worker_threads");
const { files, texts, pattern, flags, start, context, maxMatches, softMs, maxLineBytes, longContext } = workerData;
const test = new RegExp(pattern, flags);
const CHUNK = 1024 * 1024;
const deadline = Date.now() + softMs;
const NL = 10;

function scanTexts() {
	const matched = [];
	for (let index = 0; index < texts.length; index++) if (test.test(texts[index])) matched.push(index);
	return { type: "octocode-history-matches", results: [{ index: 0, lines: {}, matched }], scanned: 0, unreadable: 0, skippedLines: 0 };
}

function scanFiles() {
	const results = [];
	let found = 0;
	let unreadable = 0;
	let skippedLines = 0;
	let scanned = 0;
	let next;
	for (let index = start.file; index < files.length; index++) {
		const resumed = index === start.file;
		let position = resumed ? start.offset : 0;
		let lineNo = resumed ? start.line : 0;
		let fd;
		const result = { index, lines: {}, matched: [] };
		let stoppedAt;
		let readable = true;
		try {
			fd = fs.openSync(files[index], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
			if (!fs.fstatSync(fd).isFile()) { unreadable++; readable = false; continue; }
			const before = [];
			let after = 0;
			let carry = Buffer.alloc(0);
			let skipping = false;
			const keep = (at, text) => {
				result.lines[at] = text;
			};
			const handle = (text, at) => {
				const hit = test.test(text);
				if (hit) {
					result.matched.push(at);
					found++;
					for (const [earlier, line] of before) keep(earlier, line.length > longContext ? line.length : line);
					before.length = 0;
					keep(at, text);
					after = context;
				} else if (after > 0) {
					after--;
					keep(at, text.length > longContext ? text.length : text);
				} else if (context > 0) {
					before.push([at, text]);
					if (before.length > context) before.shift();
				}
			};
			for (let eof = false; !eof;) {
				const chunk = Buffer.allocUnsafe(CHUNK);
				const count = fs.readSync(fd, chunk, 0, CHUNK, position);
				eof = count === 0;
				const base = position - carry.length;
				position += count;
				const buffer = carry.length ? Buffer.concat([carry, chunk.subarray(0, count)]) : chunk.subarray(0, count);
				let from = 0;
				for (;;) {
					const end = buffer.indexOf(NL, from);
					const last = end < 0;
					if (last && !(eof && from < buffer.length && !skipping)) {
						if (skipping && eof) { skippedLines++; lineNo++; }
						break;
					}
					const stop = last ? buffer.length : end;
					if (!skipping) {
						if (found >= maxMatches || Date.now() > deadline) {
							stoppedAt = { file: index, offset: base + from, line: lineNo };
							break;
						}
						if (stop - from > maxLineBytes) { skippedLines++; }
						else handle(buffer.toString("utf8", from, stop), lineNo);
					} else {
						skipping = false;
						skippedLines++;
					}
					lineNo++;
					from = stop + 1;
					if (last) break;
				}
				if (stoppedAt) break;
				const rest = buffer.subarray(Math.min(from, buffer.length));
				if (skipping) carry = Buffer.alloc(0);
				else if (rest.length > maxLineBytes) { skipping = true; carry = Buffer.alloc(0); }
				else carry = Buffer.from(rest);
			}
		} catch (error) {
			if (!error.code) throw error;
			unreadable++;
			readable = false;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
		if (result.matched.length) results.push(result);
		if (stoppedAt) { next = stoppedAt; break; }
		if (readable) scanned++;
	}
	return { type: "octocode-history-matches", results, scanned, next, unreadable, skippedLines };
}

try {
	parentPort.postMessage(texts ? scanTexts() : scanFiles());
} catch (error) {
	parentPort.postMessage({ type: "octocode-history-matches", error: error.message });
}
`;
