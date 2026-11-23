import fs from "node:fs";
import path from "node:path";
import { formatAnchor } from "@octocodeai/octocode-contracts/evidence";
import { MESSAGES_HEADING, oneLine } from "./text.ts";
import { SEGMENT_NAME, segmentsIn } from "./segments.ts";

/**
 * The messages of a segment file as addressable entries. A segment whose header says `entryIds` (`segments.ts`) heads
 * each message `### <role> · <time> · entry <session entry id>`; only then is the id authoritative. A legacy segment's
 * ids were derived by role and time, so it yields no entry and no anchor.
 */

export interface SegmentEntry {
	/** The session entry id in the heading. */
	entry: string;
	role: string;
	time?: string;
	/** 0-based line of the heading; the message text is the lines after it up to `end` (exclusive). */
	line: number;
	end: number;
}

const HEADING = /^### (.+)$/;
const TIME = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;
const OPENING_FENCE = /^(`{3,})/;

/** The entry headings of `lines`, in order. Fenced text never counts: a message cannot fake a heading. */
function segmentEntries(lines: readonly string[]): SegmentEntry[] {
	const body = lines.indexOf(MESSAGES_HEADING);
	if (body < 0) return [];
	const entries: SegmentEntry[] = [];
	let closing: string | undefined;
	for (let at = body + 1; at < lines.length; at++) {
		const line = lines[at];
		if (closing !== undefined) {
			if (line === closing) closing = undefined;
			continue;
		}
		const fence = OPENING_FENCE.exec(line)?.[1];
		if (fence) {
			closing = fence;
			continue;
		}
		const heading = HEADING.exec(line)?.[1];
		if (heading === undefined) continue;
		const parts = heading.split(" · ");
		const entry = parts.find((part) => part.startsWith("entry "))?.slice("entry ".length);
		if (entry === undefined) continue;
		const time = parts.slice(1).find((part) => TIME.test(part));
		entries.push({ entry, role: parts[0], ...(time ? { time } : {}), line: at, end: lines.length });
	}
	for (let index = 0; index + 1 < entries.length; index++) entries[index].end = entries[index + 1].line;
	return entries;
}

/** The message text of `entry` in the lines it was read from. */
export const entryText = (lines: readonly string[], entry: SegmentEntry): string =>
	lines
		.slice(entry.line + 1, entry.end)
		.join("\n")
		.trim();

/** The entry of `entry` id in `lines`, comparing as the writer wrote it (one line, controls visible). */
export const findEntry = (lines: readonly string[], id: string): SegmentEntry | undefined =>
	segmentEntries(lines).find((candidate) => candidate.entry === oneLine(id));

/**
 * The anchors of the messages that contain the 0-based `hitLines` of segment `file`, in line order, without repeats:
 * empty unless the file is a segment whose header declares authoritative entry ids.
 */
export function hitAnchors(file: string, hitLines: readonly number[]): string[] {
	const name = path.basename(file);
	const n = SEGMENT_NAME.exec(name)?.[1];
	if (n === undefined || hitLines.length === 0) return [];
	const segment = segmentsIn(path.dirname(file), [{ n: Number(n), name }])[0];
	if (!segment?.entryIds || segment.session === "?") return [];
	let lines: string[];
	try {
		lines = fs.readFileSync(file, "utf8").split("\n");
	} catch {
		return [];
	}
	const entries = segmentEntries(lines);
	const anchors = new Set<string>();
	for (const hit of [...hitLines].sort((a, b) => a - b)) {
		const owner = entries.findLast((entry) => entry.line <= hit);
		if (owner && hit < owner.end)
			anchors.add(
				formatAnchor({ kind: "archive", sessionId: segment.session, segment: segment.n, entryId: owner.entry }),
			);
	}
	return [...anchors];
}
