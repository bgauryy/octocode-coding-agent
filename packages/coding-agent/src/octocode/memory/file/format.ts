import { storedSecret, storedText } from "@octocodeai/octocode-common/sanitize";
import { normalizeTitle } from "../query.ts";

/**
 * The MEMORY.md format: fixed `##` sections in this order, each shown only when it holds a line, and one fact per
 * `- ` line: `- [!] <rule>; <why or how> (<source> YYYY-MM-DD)`. A leading `!` pins the line (never evicted). The
 * trailing source and date say who last confirmed it and when; a hand-written line without them counts as the user's.
 */

export const MEMORY_SECTIONS = [
	"Preferences",
	"Decisions",
	"Gotchas",
	"Procedures",
	"Pointers",
	"Reflections",
] as const;
export type MemorySection = (typeof MEMORY_SECTIONS)[number];

/** Who last confirmed a line, highest rank first: eviction keeps a user's line over a reflection's over an agent's. */
export const MEMORY_SOURCES = ["user", "reflection", "agent"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/** The user's cap: non-blank lines, headings included. A setting may lower it, never raise it. */
const MEMORY_FILE_MAX_LINES = 30;
export const MEMORY_LINE_MAX_CHARS = 200;
export const MEMORY_FILE_MAX_BYTES = 4096;

export interface MemoryLine {
	section: MemorySection;
	pinned: boolean;
	/** The fact itself: `rule; why or how`. */
	text: string;
	source: MemorySource;
	/** `YYYY-MM-DD` of the last confirmation; absent on a hand-written line without one. */
	date?: string;
	/** Text after the date in the trailer (`recheck`), kept as written. */
	note?: string;
}

/** Content of a file that Octocode cannot place in a section: a writer refuses the file until it is fixed by hand. */
interface MemoryFileProblem {
	/** 1-based line number. */
	line: number;
	text: string;
	reason: string;
}

const HEADING = /^##\s+(.+?)\s*#*\s*$/;
const ITEM = /^[-*]\s+(.*)$/;
const TRAILER = /\s*\((user|agent|reflection)(?:\s+(\d{4}-\d{2}-\d{2}))?(?:,\s*([^()]*?))?\)\s*$/;

/** Every placeable line of `text`, and the content that is not one (an unknown heading, text outside a list). */
export function parseMemoryFile(text: string): { lines: MemoryLine[]; problems: MemoryFileProblem[] } {
	const lines: MemoryLine[] = [];
	const problems: MemoryFileProblem[] = [];
	let section: MemorySection | undefined;
	let unknown = false;
	for (const [index, raw] of text.replace(/^﻿/, "").split(/\r?\n/).entries()) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const heading = HEADING.exec(trimmed);
		if (heading) {
			section = MEMORY_SECTIONS.find((name) => name.toLowerCase() === heading[1].toLowerCase());
			unknown = section === undefined;
			if (unknown)
				problems.push({
					line: index + 1,
					text: trimmed,
					reason: `unknown section (use ${MEMORY_SECTIONS.join(", ")})`,
				});
			continue;
		}
		const item = ITEM.exec(trimmed);
		if (item && section) {
			lines.push(parseItem(item[1], section));
			continue;
		}
		const reason = item ? (unknown ? "under an unknown section" : "before any section") : "not a `- ` line";
		// Under an unknown heading only its heading is named once; its lines are covered by that problem.
		if (!(item && unknown)) problems.push({ line: index + 1, text: trimmed, reason });
	}
	return { lines, problems };
}

function parseItem(body: string, section: MemorySection): MemoryLine {
	const pinned = body.startsWith("!");
	const rest = pinned ? body.slice(1).trim() : body.trim();
	const trailer = TRAILER.exec(rest);
	if (!trailer) return { section, pinned, text: rest, source: "user" };
	return {
		section,
		pinned,
		text: rest.slice(0, trailer.index).trim(),
		source: trailer[1] as MemorySource,
		...(trailer[2] ? { date: trailer[2] } : {}),
		...(trailer[3]?.trim() ? { note: trailer[3].trim() } : {}),
	};
}

/** One line as the file holds it: `- ! rule; why (agent 2026-11-19)`. */
function formatMemoryLine(line: MemoryLine): string {
	const extra = line.note ? `, ${line.note}` : "";
	const trailer = line.date
		? ` (${line.source} ${line.date}${extra})`
		: line.source === "user" && !line.note
			? ""
			: ` (${line.source}${extra})`;
	return `- ${line.pinned ? "! " : ""}${line.text}${trailer}`;
}

/** The file for `lines`: sections in the fixed order, empty ones left out; "" for none. */
export function serializeMemoryFile(lines: readonly MemoryLine[]): string {
	const out: string[] = [];
	for (const section of MEMORY_SECTIONS) {
		const items = lines.filter((line) => line.section === section);
		if (items.length > 0) out.push(`## ${section}`, ...items.map(formatMemoryLine));
	}
	return out.length > 0 ? `${out.join("\n")}\n` : "";
}

/** Non-blank lines the file of `lines` has: each line plus one heading per section in use. */
export const countedLines = (lines: readonly MemoryLine[]): number =>
	lines.length + new Set(lines.map((line) => line.section)).size;

/** What two lines are compared by for duplicates and op targets: case, punctuation and spacing ignored. */
export const memoryLineKey = (text: string): string => normalizeTitle(text);

/** `YYYY-MM-DD` of `at` in local time: the date a line was last confirmed. */
export function memoryDate(at: Date | number = Date.now()): string {
	const day = new Date(at);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/** The cap a setting asks for, never above the user's 30. */
export const lineCap = (requested?: number): number =>
	Math.max(1, Math.min(MEMORY_FILE_MAX_LINES, Math.floor(requested ?? MEMORY_FILE_MAX_LINES)));

/** Why one line cannot be stored as it is, or undefined: too long, a secret, control or invisible characters, empty. */
export function lineProblem(line: MemoryLine): string | undefined {
	if (!line.text.trim()) return "an empty line";
	const formatted = formatMemoryLine(line);
	if (formatted.length > MEMORY_LINE_MAX_CHARS)
		return `${formatted.length} characters, over ${MEMORY_LINE_MAX_CHARS}: shorten the rule`;
	const secret = storedSecret({ line: line.text, note: line.note });
	if (secret) return `looks like a secret (${secret.problem})`;
	if (storedText(line.text) !== line.text || /[\r\n]/.test(line.text)) return "control or invisible characters";
	return undefined;
}

/**
 * Every reason `lines` cannot be written: over the line cap or 4 KB, a line `lineProblem` refuses, a normalized
 * duplicate, or a pinned line of `previous` that is missing or changed (pins stay byte-identical unless the user
 * approved the change: `allowPinChanges`). Empty when the file is valid.
 */
export function validateMemoryLines(
	lines: readonly MemoryLine[],
	options: { previous?: readonly MemoryLine[]; maxLines?: number; allowPinChanges?: boolean } = {},
): string[] {
	const problems: string[] = [];
	const cap = lineCap(options.maxLines);
	if (countedLines(lines) > cap) problems.push(`${countedLines(lines)} lines with headings, over the cap of ${cap}`);
	const bytes = Buffer.byteLength(serializeMemoryFile(lines));
	if (bytes > MEMORY_FILE_MAX_BYTES) problems.push(`${bytes} bytes, over ${MEMORY_FILE_MAX_BYTES}`);
	const keys = new Set<string>();
	for (const line of lines) {
		const problem = lineProblem(line);
		if (problem) problems.push(`"${line.text.slice(0, 80)}": ${problem}`);
		const key = memoryLineKey(line.text);
		if (keys.has(key)) problems.push(`"${line.text.slice(0, 80)}" repeats another line`);
		keys.add(key);
	}
	if (!options.allowPinChanges) {
		const now = new Set(lines.map(formatMemoryLine));
		for (const pin of options.previous?.filter((line) => line.pinned) ?? [])
			if (!now.has(formatMemoryLine(pin))) problems.push(`pinned line "${pin.text.slice(0, 80)}" would change`);
	}
	return problems;
}

/**
 * The lines a session may read from a file, in file order, within the caps: a line `lineProblem` refuses is skipped
 * (a secret never reaches a prompt), invisible characters are stripped first, and lines past the cap are cut.
 */
export function loadableLines(
	lines: readonly MemoryLine[],
	maxLines?: number,
): { lines: MemoryLine[]; skipped: Array<{ text: string; reason: string }> } {
	const kept: MemoryLine[] = [];
	const skipped: Array<{ text: string; reason: string }> = [];
	const cap = lineCap(maxLines);
	for (const raw of lines) {
		const line = { ...raw, text: storedText(raw.text).replace(/\s+/g, " ") };
		const problem = lineProblem(line);
		if (problem) {
			skipped.push({ text: line.text.slice(0, 80), reason: problem });
			continue;
		}
		const next = [...kept, line];
		if (countedLines(next) > cap || Buffer.byteLength(serializeMemoryFile(next)) > MEMORY_FILE_MAX_BYTES) {
			skipped.push({ text: line.text.slice(0, 80), reason: "past the file's cap" });
			continue;
		}
		kept.push(line);
	}
	return { lines: kept, skipped };
}
