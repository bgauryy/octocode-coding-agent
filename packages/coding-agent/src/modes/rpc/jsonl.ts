import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such as
 * U+2028 and U+2029. Clients must split records on `\n` only.
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * Attach an LF-only JSONL reader to a stream.
 *
 * This intentionally does not use Node readline. Readline splits on additional
 * Unicode separators that are valid inside JSON strings and therefore does not
 * implement strict JSONL framing.
 */
export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
	const decoder = new StringDecoder("utf8");
	// The unterminated tail, kept as pieces and searched only once each, so a record spread over many chunks is
	// read in time linear in its length.
	let pending: string[] = [];

	const emitLine = (line: string) => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	const onData = (chunk: string | Buffer) => {
		const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
		let start = 0;
		for (let newlineIndex = text.indexOf("\n"); newlineIndex !== -1; newlineIndex = text.indexOf("\n", start)) {
			pending.push(text.slice(start, newlineIndex));
			const line = pending.join("");
			pending = [];
			start = newlineIndex + 1;
			emitLine(line);
		}
		if (start < text.length) pending.push(text.slice(start));
	};

	const onEnd = () => {
		pending.push(decoder.end());
		const rest = pending.join("");
		pending = [];
		if (rest.length > 0) emitLine(rest);
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
