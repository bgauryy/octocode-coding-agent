import type { Readable } from "node:stream";

/** A startup file or completion may print without newlines: readline would retain that output without a bound. */
const MAX_LINE_CHARS = 64 * 1024;

export function readDriverLines(input: Readable, onLine: (line: string) => void, onOverflow: () => void): () => void {
	let buffer = "";
	let stopped = false;
	let skipLF = false;
	const stop = () => {
		stopped = true;
		buffer = "";
		input.off("data", receive);
	};
	const receive = (chunk: string) => {
		let start = 0;
		while (!stopped && start < chunk.length) {
			if (skipLF) {
				skipLF = false;
				if (chunk[start] === "\n") start++;
				if (start === chunk.length) return;
			}
			const lf = chunk.indexOf("\n", start);
			const cr = chunk.indexOf("\r", start);
			const end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
			const part = chunk.slice(start, end < 0 ? chunk.length : end);
			if (buffer.length + part.length > MAX_LINE_CHARS) {
				stop();
				onOverflow();
				return;
			}
			buffer += part;
			if (end < 0) return;
			const line = buffer;
			buffer = "";
			skipLF = chunk[end] === "\r";
			onLine(line);
			start = end + 1;
		}
	};
	input.setEncoding("utf8");
	input.on("data", receive);
	return stop;
}
