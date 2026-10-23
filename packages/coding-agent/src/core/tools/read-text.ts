import { createReadStream } from "node:fs";
import { DEFAULT_MAX_BYTES, truncateHead, type TruncationResult } from "./truncate.ts";

interface TextWindow {
	totalFileLines: number;
	selectedLines: number;
	firstLineBytes: number;
	truncation: TruncationResult;
}

/** Count the source while retaining only a bounded preview, including when one line spans many chunks. */
export async function readTextWindow(
	file: string,
	offset: number,
	limit?: number,
	signal?: AbortSignal,
): Promise<TextWindow> {
	let line = 1;
	let prefix = "";
	let selectedLines = 0;
	let selectedBytes = 0;
	let firstLineBytes = 0;
	let lastSelectedLineBytes = 0;
	let startedLine = false;
	const append = (text: string) => {
		if (prefix.length <= DEFAULT_MAX_BYTES) prefix += text.slice(0, DEFAULT_MAX_BYTES + 1 - prefix.length);
	};
	const part = (text: string) => {
		if (line < offset || (limit !== undefined && line >= offset + limit)) return;
		if (!startedLine) {
			if (selectedLines > 0) {
				selectedBytes++;
				append("\n");
			}
			selectedLines++;
			lastSelectedLineBytes = 0;
			startedLine = true;
		}
		const bytes = Buffer.byteLength(text);
		selectedBytes += bytes;
		lastSelectedLineBytes += bytes;
		if (line === offset) firstLineBytes += bytes;
		append(text);
	};
	for await (const chunk of createReadStream(file, { encoding: "utf8", signal })) {
		signal?.throwIfAborted();
		const parts = (chunk as string).split("\n");
		for (let index = 0; index < parts.length; index++) {
			part(parts[index]);
			if (index < parts.length - 1) {
				line++;
				startedLine = false;
			}
		}
	}
	part("");
	const truncation = truncateHead(prefix);
	truncation.totalBytes = selectedBytes;
	truncation.totalLines = selectedBytes === 0 ? 0 : selectedLines - (lastSelectedLineBytes === 0 ? 1 : 0);
	return { totalFileLines: line, selectedLines, firstLineBytes, truncation };
}
