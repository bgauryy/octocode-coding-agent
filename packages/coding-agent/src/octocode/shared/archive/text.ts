import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { headerText } from "../fence.ts";
import { visibleControls } from "../sanitize.ts";

/** How archived message text may appear in a file: one line, fenced, or an inline code span, controls made visible. */

/** Where the messages start; the header ends before it. */
export const MESSAGES_HEADING = "## Messages";

/** `text` on one line, controls visible and whole (never clipped): it cannot start a line of its own. */
export const oneLine = (text: string): string => headerText(text, Infinity);

/** The longest run of backticks in `text`. */
function longestTicks(text: string): number {
	let longest = 0;
	for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
	return longest;
}

/**
 * `text` verbatim (controls made visible) in a fenced block that no backtick run inside it can close, so archived text
 * cannot fake a heading or end its block. `info` is the language tag.
 */
export function fence(text: string, info = ""): string {
	const body = visibleControls(text);
	const ticks = "`".repeat(Math.max(3, longestTicks(body) + 1));
	return `${ticks}${info}\n${body}\n${ticks}`;
}

/** A name or id from a message as one inline code span: one line, controls visible, and no backtick in it can end the span. */
export function inlineCode(text: string): string {
	const line = oneLine(text);
	const ticks = "`".repeat(longestTicks(line) + 1);
	const pad = line === "" || line.startsWith("`") || line.endsWith("`") ? " " : "";
	return `${ticks}${pad}${line}${pad}${ticks}`;
}

/** A message heading's parts (role, custom type, entry id) on one line: the heading cannot be split or forged. */
export const headingText = oneLine;

/** The header of `file` (up to the line `end`), read in chunks so a large file is never loaded whole; undefined when unreadable. */
export function readHeader(file: string, end = `\n${MESSAGES_HEADING}\n`): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const buffer = Buffer.alloc(16_384);
		// A character split across two chunks is decoded whole.
		const decoder = new StringDecoder("utf8");
		let text = "";
		for (
			let read = fs.readSync(fd, buffer, 0, buffer.length, null);
			read > 0;
			read = fs.readSync(fd, buffer, 0, buffer.length, null)
		) {
			text += decoder.write(buffer.subarray(0, read));
			const at = text.indexOf(end);
			if (at >= 0) return text.slice(0, at);
		}
		return text + decoder.end();
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}
