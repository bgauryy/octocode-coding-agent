import { Worker } from "node:worker_threads";

interface HistoryMatches {
	index: number;
	lines: string[];
	matched: number[];
}

const SEARCH_BYTES = 32 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 5_000;

// Inline JavaScript needs no source file or TypeScript loader in an installed bundle.
const source = String.raw`
const fs = require("node:fs");
const { parentPort, workerData } = require("node:worker_threads");
const { files, pattern, flags, maxBytes } = workerData;
const test = new RegExp(pattern, flags);
const results = [];
let bytes = 0;
try {
	for (let index = 0; index < files.length; index++) {
		let fd;
		let text;
		try {
			fd = fs.openSync(files[index], "r");
			const stat = fs.fstatSync(fd);
			if (!stat.isFile()) continue;
			if (stat.size > maxBytes - bytes) throw new Error("archive search exceeds 32 MiB; narrow file to a session folder or one archive file.");
			const chunks = [];
			for (;;) {
				const chunk = Buffer.allocUnsafe(Math.min(65536, maxBytes - bytes + 1));
				const count = fs.readSync(fd, chunk, 0, chunk.length, null);
				if (!count) break;
				bytes += count;
				if (bytes > maxBytes) throw new Error("archive search exceeds 32 MiB; narrow file to a session folder or one archive file.");
				chunks.push(chunk.subarray(0, count));
			}
			text = Buffer.concat(chunks).toString("utf8");
		} catch (error) {
			if (!error.code) throw error;
			continue;
		} finally {
			if (fd !== undefined) fs.closeSync(fd);
		}
		const lines = text.split("\n");
		const matched = [];
		for (let line = 0; line < lines.length; line++) {
			if (test.test(lines[line])) matched.push(line);
		}
		if (matched.length) results.push({ index, lines, matched });
	}
	parentPort.postMessage({ type: "octocode-history-matches", results });
} catch (error) {
	parentPort.postMessage({ type: "octocode-history-matches", error: error.message });
}
`;

/** Keep filesystem scans and backtracking regexes off the agent's event loop; aborts terminate the worker. */
export async function matchHistory(
	files: readonly string[],
	pattern: RegExp,
	signal?: AbortSignal,
): Promise<HistoryMatches[]> {
	signal?.throwIfAborted();
	if (files.length === 0) return [];
	const worker = new Worker(source, {
		eval: true,
		execArgv: [],
		workerData: {
			files,
			pattern: pattern.source,
			flags: pattern.flags.replace("g", ""),
			maxBytes: SEARCH_BYTES,
		},
		resourceLimits: { maxOldGenerationSizeMb: 256 },
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	try {
		return await new Promise<HistoryMatches[]>((resolve, reject) => {
			abort = () => reject(signal?.reason ?? new Error("Archive search aborted."));
			signal?.addEventListener("abort", abort, { once: true });
			timer = setTimeout(
				() =>
					reject(
						new Error(
							"Archive search exceeded 5 seconds; simplify query or narrow file to a session folder or one archive file.",
						),
					),
				SEARCH_TIMEOUT_MS,
			);
			worker.on("message", (message: { type?: string; results?: HistoryMatches[]; error?: string }) => {
				if (message?.type !== "octocode-history-matches") return;
				if (message.error) reject(new Error(message.error));
				else resolve(message.results ?? []);
			});
			worker.once("error", reject);
			worker.once("exit", (code) =>
				reject(new Error(`Archive search worker exited before returning results (code ${code}).`)),
			);
			if (signal?.aborted) abort();
		});
	} finally {
		clearTimeout(timer);
		if (abort) signal?.removeEventListener("abort", abort);
		await worker.terminate();
	}
}
