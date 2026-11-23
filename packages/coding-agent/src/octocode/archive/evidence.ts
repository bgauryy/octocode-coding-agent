import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { type EvidenceRead, formatAnchor, type SourceAnchor } from "@octocodeai/octocode-contracts/evidence";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { compactions } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { segmentFiles, segmentsIn } from "../history/archive.ts";
import { entryText, findEntry } from "../history/archive/entries.ts";
import { historySessions } from "../history/transcripts.ts";

/**
 * The one bounded, scoped read of an anchor, for the `archive` tool, the terminal and the web. An anchor resolves only
 * inside the caller's history scope; a foreign session, a legacy segment (its ids were derived, not persisted), an
 * entry the segment does not hold and any other anchor that cannot be verified read as `missing`, never as another
 * session's text or "the latest". Retention-removed segments read as `expired`.
 */

/** Bytes of text one read returns before it offers a cursor. */
const EVIDENCE_BYTES = 12_000;
/** The most bytes a caller may ask for in one read. */
const EVIDENCE_MAX_BYTES = 64_000;

export interface EvidenceOptions {
	/** Continues a truncated read: the `nextCursor` of the previous one, with the same anchor. */
	cursor?: string;
	/** Bytes of text to return, at most `EVIDENCE_MAX_BYTES`; default `EVIDENCE_BYTES`. */
	maxBytes?: number;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	/** Whether retention removed segment `n` of `sessionId`; default reads the compaction catalog. */
	expired?: (sessionId: string, n: number) => boolean;
}

const CURSOR = /^b(\d+)$/;

const retentionRemoved = (sessionId: string, n: number): boolean =>
	compactions
		.forSession(sharedAgentDb().mirror.db, sessionId)
		.some((row) => row.detailState === "expired" && path.basename(row.detailFile ?? "").startsWith(`${n}-`));

interface Found {
	author?: string;
	time?: string;
	text: string;
}

/** `found`'s text from byte offset `cursor`, at most `limit` bytes, cut on a character boundary. */
function page(anchor: SourceAnchor, found: Found, cursor: string | undefined, limit: number): EvidenceRead {
	const bytes = Buffer.from(found.text);
	let from = 0;
	if (cursor !== undefined) {
		const offset = CURSOR.exec(cursor)?.[1];
		from = offset === undefined ? -1 : Number(offset);
		const boundary = from >= 0 && from < bytes.length && (bytes[from] & 0xc0) !== 0x80;
		if (!boundary) throw new Error("Invalid evidence cursor: repeat the read without cursor.");
	}
	let end = Math.min(bytes.length, from + limit);
	while (end < bytes.length && end > from && (bytes[end] & 0xc0) === 0x80) end--;
	if (end === from && from < bytes.length) end = Math.min(bytes.length, from + 4);
	const truncated = end < bytes.length;
	return {
		anchor,
		availability: "present",
		...(found.author ? { author: found.author } : {}),
		...(found.time ? { time: found.time } : {}),
		text: bytes.subarray(from, end).toString(),
		truncated,
		...(truncated ? { nextCursor: `b${end}` } : {}),
	};
}

const text = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.flatMap((part) =>
						isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
					)
					.join("\n\n")
			: "";

/** The entry `entryId` of a session file, streamed; undefined when the file is not that session's or lacks the entry. */
async function transcriptEntry(
	file: string,
	sessionId: string,
	entryId: string,
	signal?: AbortSignal,
): Promise<Found | undefined> {
	const stream = fs.createReadStream(file, { encoding: "utf8" });
	const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
	const needle = JSON.stringify(entryId);
	let header = false;
	try {
		for await (const line of lines) {
			signal?.throwIfAborted();
			if (!header) {
				header = true;
				const first: unknown = JSON.parse(line);
				// A session file's first line names the session; a file of another session is not read.
				if (!isRecord(first) || first.type !== "session" || first.id !== sessionId) return undefined;
				continue;
			}
			if (!line.includes(needle)) continue;
			const entry: unknown = JSON.parse(line);
			if (!isRecord(entry) || entry.id !== entryId) continue;
			const time = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
			const message = isRecord(entry.message) ? entry.message : undefined;
			if (entry.type === "message" && message)
				return {
					author: typeof message.role === "string" ? message.role : "unknown",
					...(time ? { time } : {}),
					text: text(message.content),
				};
			if (entry.type === "custom_message")
				return { author: "custom", ...(time ? { time } : {}), text: text(entry.content) };
			if (entry.type === "compaction" && typeof entry.summary === "string")
				return { author: "compaction", ...(time ? { time } : {}), text: entry.summary };
			return undefined;
		}
		return undefined;
	} finally {
		lines.close();
		stream.destroy();
	}
}

/**
 * Reads `anchor` within the caller's history scope (`historySessions`: this session, the sessions it was forked from, its parent and this repository's). `missing` covers every anchor that cannot be verified
 * there; `expired` a segment that retention removed; `present` carries the message's role, time and text, bounded by
 * `maxBytes` with a `nextCursor` while more follows.
 */
export async function readEvidence(
	cwd: string,
	anchor: SourceAnchor,
	options: EvidenceOptions = {},
): Promise<EvidenceRead> {
	const env = options.env ?? process.env;
	const limit = Math.min(EVIDENCE_MAX_BYTES, Math.max(1, Math.floor(options.maxBytes ?? EVIDENCE_BYTES)));
	const missing: EvidenceRead = { anchor, availability: "missing" };
	options.signal?.throwIfAborted();
	const session = historySessions(cwd, env).find((candidate) => candidate.id === anchor.sessionId);
	if (!session) return missing;
	if (anchor.kind === "transcript") {
		const file = session.record?.transcript;
		if (!file) return missing;
		let found: Found | undefined;
		try {
			found = await transcriptEntry(file, anchor.sessionId, anchor.entryId, options.signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return missing;
			throw error;
		}
		return found ? page(anchor, found, options.cursor, limit) : missing;
	}
	const files = segmentFiles(session.folder);
	const listed = files.find((file) => file.n === anchor.segment);
	if (!listed)
		return (options.expired ?? retentionRemoved)(anchor.sessionId, anchor.segment)
			? { anchor, availability: "expired" }
			: missing;
	const segment = segmentsIn(session.folder, [listed])[0];
	// Only a segment that persisted its entry ids makes a heading authoritative.
	if (!segment?.entryIds || segment.session !== anchor.sessionId) return missing;
	let lines: string[];
	try {
		lines = fs.readFileSync(path.join(session.folder, listed.name), "utf8").split("\n");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return missing;
		throw error;
	}
	const entry = findEntry(lines, anchor.entryId);
	if (!entry) return missing;
	return page(
		anchor,
		{ author: entry.role, ...(entry.time ? { time: entry.time } : {}), text: entryText(lines, entry) },
		options.cursor,
		limit,
	);
}

/** An evidence read as the text a model or person sees: one line saying what it is, then the text. */
export function evidenceText(evidence: EvidenceRead): string {
	const anchor = formatAnchor(evidence.anchor);
	if (evidence.availability === "missing")
		return `${anchor} · missing: not in the history this session may read, or not verifiable (a segment written before entry ids were stored has no anchors).`;
	if (evidence.availability === "expired") return `${anchor} · expired: its archive was removed by retention.`;
	const head = [anchor, evidence.author, evidence.time].filter(Boolean).join(" · ");
	return `${head}\n\n${evidence.text ?? ""}`;
}
