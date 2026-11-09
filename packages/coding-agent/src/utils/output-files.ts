/**
 * Output files: files Octocode writes so the model can use output it was not shown in full, such as the
 * full text of truncated tool output, binary MCP resources, and images shown by programmatic tool callers.
 * Every output file is created here, so where they are stored can change in one place. Today they
 * go to the active session’s private workspace output folder.
 */

import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	copyFileSync,
	createReadStream,
	createWriteStream,
	fstatSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	type WriteStream,
} from "node:fs";
import { runtimeTempDir } from "../storage/runtime-paths.ts";
import { basename, join } from "node:path";
import { finished, pipeline } from "node:stream/promises";

/** Output can carry private data, so only the user may read the files. */
const OUTPUT_FILE_MODE = 0o600;
const completedOutputs = new Map<string, { dev: number; ino: number }>();

/** The most of a user shell command's spilled output a view reads back. */
export const DISPLAY_OUTPUT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Whether `readOutputFile` can read `path` at `maxBytes`, without reading it. Throws when the file is over the limit, as
 * that read would.
 */
export function outputFileReadable(path: string, maxBytes: number): boolean {
	const identity = completedOutputs.get(path);
	const stat = identity && statSync(path, { throwIfNoEntry: false });
	if (!stat?.isFile() || stat.dev !== identity?.dev || stat.ino !== identity.ino) return false;
	if (stat.size > maxBytes) throw new Error("Full output exceeds the display byte limit");
	return true;
}

/** Only completed files created by this process may become display data. Persisted paths grant no read authority. */
export function readOutputFile(path: string, maxBytes: number): string | undefined {
	const identity = completedOutputs.get(path);
	if (!identity) return undefined;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid output byte limit");
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch {
		return undefined;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino) return undefined;
		if (stat.size > maxBytes) throw new Error("Full output exceeds the display byte limit");
		const buffer = Buffer.allocUnsafe(stat.size + 1);
		let length = 0;
		while (length < buffer.length) {
			const bytes = readSync(fd, buffer, length, buffer.length - length, null);
			if (bytes === 0) break;
			length += bytes;
		}
		if (length > stat.size) throw new Error("Output changed while being read");
		return buffer.toString("utf8", 0, length);
	} finally {
		closeSync(fd);
	}
}

/**
 * Moves a completed output file of this process into `dir`, so it can be read with `readOutputFile` at its new path;
 * returns that path, or the old one when the file could not move.
 */
export function moveOutputFile(path: string, dir: string): string {
	const target = join(dir, basename(path));
	const identity = completedOutputs.get(path);
	try {
		try {
			renameSync(path, target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
			copyFileSync(path, target, constants.COPYFILE_EXCL);
			rmSync(path, { force: true });
		}
		chmodSync(target, OUTPUT_FILE_MODE);
		if (identity) {
			const { dev, ino } = statSync(target);
			completedOutputs.delete(path);
			completedOutputs.set(target, { dev, ino });
		}
		return target;
	} catch {
		return path;
	}
}

/** A new, unused path: `<dir>/<prefix>-<random hex><extension>`. `extension` includes the dot. */
function createOutputFilePath(prefix: string, extension: string): string {
	return join(runtimeTempDir(), `${prefix}-${randomBytes(8).toString("hex")}${extension}`);
}

/** A write stream for a new private file; its identity is known once it opened, and `completion` settles when it ended. */
function openPrivateStream(path: string): {
	stream: WriteStream;
	completion: Promise<void>;
	identity: () => { dev: number; ino: number } | undefined;
} {
	const stream = createWriteStream(path, { mode: OUTPUT_FILE_MODE, flags: "wx" });
	let identity: { dev: number; ino: number } | undefined;
	stream.once("open", (fd) => {
		const { dev, ino } = fstatSync(fd);
		identity = { dev, ino };
	});
	const completion = finished(stream, { cleanup: true });
	// Observe failures immediately, including errors before callers finish producing output.
	void completion.catch(() => undefined);
	return { stream, completion, identity: () => identity };
}

/** Open a new output file for streamed output. */
export function createOutputFileStream(
	prefix: string,
	extension: string,
): { path: string; stream: WriteStream; close: () => Promise<void> } {
	const path = createOutputFilePath(prefix, extension);
	const { stream, completion, identity } = openPrivateStream(path);
	let closing = false;
	return {
		path,
		stream,
		close: () => {
			if (!closing) {
				closing = true;
				stream.end();
			}
			return completion.then(() => {
				const opened = identity();
				if (opened) completedOutputs.set(path, opened);
			});
		},
	};
}

/** A size-capped output file: see `createCappedOutputFile`. */
export interface CappedOutputFile {
	readonly path: string;
	/** Bytes dropped from the middle so far. */
	readonly droppedBytes: number;
	write(chunk: Buffer): void;
	/** Resolves once the file holds what was kept. Repeat calls share one close; a write after it is ignored. */
	close(): Promise<void>;
}

interface TailSegment {
	path: string;
	bytes: number;
	stream: WriteStream;
	completion: Promise<void>;
}

/**
 * An output file that never holds more than about `maxBytes`, however much is written: the first half stays in the file,
 * and what follows goes to two rotating tail segments of a quarter each (the design of `RotatingLog`, with the head kept
 * and streams in place of its synchronous writes, which a command printing 500 MB/s would turn into a stalled event
 * loop). `close()` appends the segments, so readers have one file. A marker from `dropNote` stands where the middle was;
 * output that fit comes out byte for byte. `maxBytes` 0 means no cap.
 */
export function createCappedOutputFile(
	prefix: string,
	extension: string,
	maxBytes: number,
	dropNote: (droppedBytes: number) => string,
): CappedOutputFile {
	const head = createOutputFileStream(prefix, extension);
	const headRoom = maxBytes > 0 ? Math.max(1, Math.floor(maxBytes / 2)) : Number.POSITIVE_INFINITY;
	const segmentRoom = Math.max(1, Math.floor(maxBytes / 4));
	let headBytes = 0;
	let droppedBytes = 0;
	let nextSegment = 0;
	const segments: TailSegment[] = [];
	const removals: Promise<void>[] = [];
	let closing: Promise<void> | undefined;

	/** Starts a segment, first giving up the oldest once two exist: that is the only moment bytes are lost. */
	const rotate = (): TailSegment => {
		const oldest = segments.length === 2 ? segments.shift() : undefined;
		if (oldest) {
			droppedBytes += oldest.bytes;
			// What is still queued for it no longer matters, so it is discarded rather than flushed.
			oldest.stream.destroy();
			removals.push(oldest.completion.catch(() => undefined).then(() => rmSync(oldest.path, { force: true })));
		}
		const path = `${head.path}.tail-${nextSegment++}`;
		const segment = { path, bytes: 0, ...openPrivateStream(path) };
		segments.push(segment);
		return segment;
	};

	const write = (chunk: Buffer): void => {
		let rest = chunk;
		if (headBytes < headRoom) {
			const part = rest.subarray(0, headRoom - headBytes);
			head.stream.write(part);
			headBytes += part.length;
			rest = rest.subarray(part.length);
		}
		while (rest.length > 0) {
			const last = segments.at(-1);
			const segment = last && last.bytes < segmentRoom ? last : rotate();
			const part = rest.subarray(0, segmentRoom - segment.bytes);
			segment.stream.write(part);
			segment.bytes += part.length;
			rest = rest.subarray(part.length);
		}
	};

	/** The segments' bytes after the head, with the marker first when anything was dropped. */
	const joinTail = async (): Promise<void> => {
		const file = createWriteStream(head.path, { flags: "a" });
		const fileDone = finished(file);
		void fileDone.catch(() => undefined);
		try {
			if (droppedBytes > 0) file.write(dropNote(droppedBytes));
			for (const segment of segments) await pipeline(createReadStream(segment.path), file, { end: false });
		} finally {
			file.end();
			await fileDone;
		}
	};

	const close = async (): Promise<void> => {
		for (const segment of segments) segment.stream.end();
		try {
			await head.close();
			await Promise.all(segments.map((segment) => segment.completion));
			await Promise.all(removals);
			if (segments.length > 0) await joinTail();
		} finally {
			for (const segment of segments) rmSync(segment.path, { force: true });
		}
	};

	return {
		path: head.path,
		get droppedBytes() {
			return droppedBytes;
		},
		write: (chunk) => {
			if (!closing) write(chunk);
		},
		close: () => (closing ??= close()),
	};
}
