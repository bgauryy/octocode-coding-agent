import fs from "node:fs";
import path from "node:path";
import { stringList } from "../../shared/util.ts";
import { headerField, readHeader } from "./text.ts";

/**
 * A segment file's header as data: the segment files of an archive folder and the header of each, parsed once per file
 * stamp. `../archive.ts` writes them; a segment file is written once, so its parsed header stays valid while its size,
 * mtime and inode do.
 */

/** One archived compaction: what the header of its file says. */
export interface Segment {
	/** 1 for the first compaction of the session. */
	n: number;
	session: string;
	/** The id of the compaction entry in Octocode's session file. */
	entry: string;
	/** ISO times of the oldest and newest archived message. */
	from?: string;
	to?: string;
	tokensBefore: number;
	/** How the summary was written: `cache-shared`, `standalone` or `octocode-default`. */
	method: string;
	/** A one-line label of the segment: the summary's own TL;DR or a fallback (the file has the whole text). */
	tldr: string;
	topics: string[];
	readFiles: string[];
	modifiedFiles: string[];
	/** Messages in the file. */
	messages: number;
	/** The session entry that was the branch's leaf when the compaction began: segments of different `/tree` branches differ here. */
	leaf?: string;
	/** `session-entries` when every message heading's entry id is the persisted entry id carried from the compaction's preparation; absent in segments written before that, whose ids were derived by role and time. */
	entryIds?: typeof ENTRY_IDS_SOURCE;
}

/** The `entryIds` value of a segment whose message ids are authoritative. */
export const ENTRY_IDS_SOURCE = "session-entries";

/** The label of a segment file whose header cannot be read. */
const UNREADABLE_HEADER = "unreadable header";

/** A segment file's name: `<n>-<compaction entry id>.md`. */
export const SEGMENT_NAME = /^(\d+)-.+\.md$/;

/** Whether file name `name` is a segment's. */
export const isSegmentFile = (name: string): boolean => SEGMENT_NAME.test(name);

/** The segment files in `folder` by number, ascending; an unreadable or missing folder has none. */
export function segmentFiles(folder: string): Array<{ n: number; name: string }> {
	try {
		return fs
			.readdirSync(folder)
			.flatMap((name) => {
				const n = SEGMENT_NAME.exec(name)?.[1];
				return n === undefined ? [] : [{ n: Number(n), name }];
			})
			.sort((a, b) => a.n - b.n);
	} catch {
		return [];
	}
}

/** A segment header's field labels, as `renderHeader` writes them and `parseHeader` reads them. */
export const LABELS = {
	segment: "Segment",
	entry: "Compaction entry",
	leaf: "Branch leaf",
	entryIds: "Message entry ids",
	range: "Time range",
	tokensBefore: "Tokens before",
	method: "Summary method",
	tldr: "TL;DR",
	topics: "Topics",
	readFiles: "Files read",
	modifiedFiles: "Files modified",
	messages: "Messages",
} as const;

function parseHeader(header: string, n: number): Segment | undefined {
	const field = (label: string): string | undefined => headerField(header, label);
	const list = (label: string): string[] => {
		try {
			return stringList(JSON.parse(field(label) ?? "[]")) ?? [];
		} catch {
			return [];
		}
	};
	const entry = field(LABELS.entry);
	const session = /^# Archived history of session (.*), segment \d+$/m.exec(header)?.[1];
	if (entry === undefined || session === undefined) return undefined;
	const [from, to] = (field(LABELS.range) ?? "").split(" → ");
	const topics = (field(LABELS.topics) ?? "").split(", ").filter(Boolean);
	const leaf = field(LABELS.leaf);
	const entryIds = field(LABELS.entryIds) === ENTRY_IDS_SOURCE ? ENTRY_IDS_SOURCE : undefined;
	return {
		n,
		session,
		entry,
		...(leaf ? { leaf } : {}),
		...(entryIds ? { entryIds } : {}),
		...(from && from !== "?" ? { from } : {}),
		...(to && to !== "?" ? { to } : {}),
		tokensBefore: Number(field(LABELS.tokensBefore)) || 0,
		method: field(LABELS.method) ?? "unknown",
		tldr: field(LABELS.tldr) ?? "",
		topics,
		readFiles: list(LABELS.readFiles),
		modifiedFiles: list(LABELS.modifiedFiles),
		messages: Number(field(LABELS.messages)) || 0,
	};
}

/** Segment headers parsed, by file, with the stamp (size, mtime, inode) they were read at; the oldest go past the bound. */
const SEGMENT_HEADERS = 4096;
const segmentHeaders = new Map<string, { stamp: string; segment: Segment }>();

/**
 * The segments of the archive `folder`, oldest first, read from their file headers; `files` is its `segmentFiles` when
 * the caller listed it already.
 */
export function segmentsIn(folder: string, files = segmentFiles(folder)): Segment[] {
	return files.map(({ n, name }) => {
		const file = path.join(folder, name);
		const stat = fs.statSync(file, { throwIfNoEntry: false });
		const stamp = stat ? `${stat.size}:${stat.mtimeMs}:${stat.ino}` : undefined;
		const known = segmentHeaders.get(file);
		if (stamp !== undefined && known?.stamp === stamp) return { ...known.segment };
		const header = readHeader(file);
		const segment = header === undefined ? undefined : parseHeader(header, n);
		if (!segment) return unreadable(n, name);
		if (stamp !== undefined) {
			segmentHeaders.delete(file);
			if (segmentHeaders.size >= SEGMENT_HEADERS) segmentHeaders.delete(segmentHeaders.keys().next().value!);
			segmentHeaders.set(file, { stamp, segment });
		}
		return { ...segment };
	});
}

/** The row of a segment file whose header cannot be read: it keeps its number and its file name, and says what is wrong. */
const unreadable = (n: number, name: string): Segment => ({
	n,
	session: "?",
	entry: name.replace(/^\d+-/, "").replace(/\.md$/, ""),
	tokensBefore: 0,
	method: "unknown",
	tldr: UNREADABLE_HEADER,
	topics: [],
	readFiles: [],
	modifiedFiles: [],
	messages: 0,
});
