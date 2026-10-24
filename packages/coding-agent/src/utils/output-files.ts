/**
 * Output files: files pi writes so the model can use output it was not shown in full, such as the
 * full text of truncated tool output, binary MCP resources, and images shown by programmatic tool callers.
 * Every output file is created here, so where they are stored can change in one place. Today they
 * go to the OS temp directory.
 */

import { randomBytes } from "node:crypto";
import { closeSync, constants, createWriteStream, fstatSync, openSync, readSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";

/** Output can carry private data, so only the user may read the files. */
const OUTPUT_FILE_MODE = 0o600;
const completedOutputs = new Map<string, { dev: number; ino: number }>();

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

/** A new, unused path: `<dir>/<prefix>-<random hex><extension>`. `extension` includes the dot. */
function createOutputFilePath(prefix: string, extension: string): string {
	return join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}${extension}`);
}

/** Open a new output file for streamed output. */
export function createOutputFileStream(
	prefix: string,
	extension: string,
): { path: string; stream: WriteStream; close: () => Promise<void> } {
	const path = createOutputFilePath(prefix, extension);
	const stream = createWriteStream(path, { mode: OUTPUT_FILE_MODE, flags: "wx" });
	let identity: { dev: number; ino: number } | undefined;
	stream.once("open", (fd) => {
		const { dev, ino } = fstatSync(fd);
		identity = { dev, ino };
	});
	const completion = finished(stream, { cleanup: true });
	// Observe failures immediately, including errors before callers finish producing output.
	void completion.catch(() => undefined);
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
				if (identity) completedOutputs.set(path, identity);
			});
		},
	};
}
