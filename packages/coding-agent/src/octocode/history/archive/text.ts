import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { headerText } from "../../shared/fence.ts";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import { escapeRegExp } from "@octocodeai/octocode-common/regexp";

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

/** The label and value of a header line `- label: value` (its value on one line, `oneLine`), or undefined. */
export function fieldOf(line: string): { label: string; value: string } | undefined {
	const field = /^- (.+?): (.*)$/.exec(line);
	return field ? { label: field[1], value: field[2] } : undefined;
}

/**
 * The fixed lines archived messages hold besides their headings and fences (`compaction/archive/render.ts` writes them
 * with `templateLine`): fixed words around slots. A `names` line's slots are names and ids in `inlineCode` spans; any
 * other slot holds the writer's own words, such as an exit status.
 */
export const MESSAGE_LINES = {
	toolCall: { parts: ["Tool call ", " (id ", "):"], names: true },
	toolResultError: { parts: ["Tool ", " · call ", " · error"], names: true },
	toolResult: { parts: ["Tool ", " · call ", ""], names: true },
	command: { parts: ["Command (", "):"], names: false },
	error: { parts: ["Error:"], names: false },
	image: { parts: ["[image omitted]"], names: false },
} as const satisfies Record<string, { parts: readonly string[]; names: boolean }>;
type MessageLine = (typeof MESSAGE_LINES)[keyof typeof MESSAGE_LINES];

/** `template`'s fixed parts with `slots` between them. */
export const templateLine = (template: MessageLine, ...slots: string[]): string =>
	template.parts.reduce<string>((line, part, index) => line + (index > 0 ? (slots[index - 1] ?? "") : "") + part, "");

/** The slots of `line` when it has the form of `parts`, else undefined. */
function slotsOf(line: string, parts: readonly string[]): string[] | undefined {
	if (parts.length === 1) return line === parts[0] ? [] : undefined;
	const last = parts[parts.length - 1];
	if (!line.startsWith(parts[0]) || !line.endsWith(last)) return undefined;
	const end = line.length - last.length;
	const slots: string[] = [];
	let at = parts[0].length;
	for (const part of parts.slice(1, -1)) {
		const found = line.indexOf(part, at);
		if (found < 0 || found > end) return undefined;
		slots.push(line.slice(at, found));
		at = found + part.length;
	}
	if (at > end) return undefined;
	slots.push(line.slice(at, end));
	return slots;
}

/** A line that opens a `fence` (its backticks and info string); the same backticks alone close it. */
const FENCE_OPEN = /^(`{3,})[^`\s]*$/;

/**
 * The text of archived message `lines` that a ranked search counts: inside a `fence`, each line as it is; outside, none
 * of a heading (a message's role, time and entry) and only the names of a `MESSAGE_LINES` line; any other line as it
 * is (text no `fence` holds, as an older or hand-made file may have).
 */
export function rankedMessageText(lines: readonly string[]): string[] {
	let fence: string | undefined;
	return lines.map((line) => {
		if (fence !== undefined) {
			if (line !== fence) return line;
			fence = undefined;
			return "";
		}
		fence = FENCE_OPEN.exec(line)?.[1];
		if (fence !== undefined || /^#{1,6} /.test(line)) return "";
		for (const template of Object.values(MESSAGE_LINES)) {
			const slots = slotsOf(line, template.parts);
			if (slots) return template.names ? slots.join(" ") : "";
		}
		return line;
	});
}

/** The value of the header line `- label: value` in `header`, or undefined when it has none. */
export const headerField = (header: string, label: string): string | undefined =>
	new RegExp(`^- ${escapeRegExp(label)}: (.*)$`, "m").exec(header)?.[1];

/** The header of `file` (up to the line `end`), read in chunks so a large file is never loaded whole; undefined when unreadable. */
export function readHeader(file: string, end = `\n${MESSAGES_HEADING}\n`): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
		if (!fs.fstatSync(fd).isFile()) return undefined;
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
