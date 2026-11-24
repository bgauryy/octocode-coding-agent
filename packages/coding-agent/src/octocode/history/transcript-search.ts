import { setImmediate } from "node:timers/promises";
import { sessions as sessionRows, transcripts } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { matchTexts } from "./search.ts";
import { transcriptText } from "./transcript-text.ts";
import type { HistorySession } from "./transcripts.ts";

/**
 * Regex search over the full transcripts of sessions (the database mirror: messages, tool calls with their arguments,
 * tool results with tool name and call id), the stores `errors` reads, which archive files (records and segments) do not
 * hold. Its cost is bounded: one pass over the mirrored lines of the sessions in order, stopped at `TRANSCRIPT_BUDGET_MS`,
 * with regexes run in the search worker; a stop says how many sessions were read, so a caller narrows with `sessionId`.
 */

/** Wall time one search spends reading transcripts before it reports where it stopped. */
const TRANSCRIPT_BUDGET_MS = 4_000;
/** Matching entries kept for display; the rest are counted. */
const MAX_HITS = 30;
/** Text of one entry tested, in characters. */
const ENTRY_CHARS = 1024 * 1024;
/** A line longer than this is tested up to here. */
const LINE_CHARS = 20_000;
/** Characters gathered before the worker tests them. */
const BATCH_CHARS = 4 * 1024 * 1024;
/** How far into a stored line its entry kind is looked for before the line is parsed. */
const HEAD_CHARS = 400;
const TESTED_TYPES = ['"type":"message"', '"type":"custom_message"', '"type":"compaction"'];

interface TranscriptHit {
	session: string;
	entryId: string;
	role: string;
	time?: string;
	/** The first matching line of the entry. */
	line: string;
}

export interface TranscriptSearch {
	/** The first `MAX_HITS` matching entries, in scan order. */
	hits: TranscriptHit[];
	/** Matching entries in all. */
	total: number;
	/** Sessions whose transcript was read to its end. */
	scanned: number;
	/** Sessions in scope, readable or not. */
	sessions: number;
	/** Sessions with no readable transcript mirror. */
	unread: number;
	/** The search stopped at its time budget before the last session. */
	stopped: boolean;
}

interface Pending {
	lines: string[];
	owners: Array<Omit<TranscriptHit, "line">>;
	chars: number;
}

export async function searchTranscripts(
	sessions: readonly HistorySession[],
	pattern: RegExp,
	signal?: AbortSignal,
	budgetMs = TRANSCRIPT_BUDGET_MS,
): Promise<TranscriptSearch> {
	const agent = sharedAgentDb();
	const db = agent.mirror.db;
	const deadline = Date.now() + budgetMs;
	const found: TranscriptSearch = {
		hits: [],
		total: 0,
		scanned: 0,
		sessions: sessions.length,
		unread: 0,
		stopped: false,
	};
	let pending: Pending = { lines: [], owners: [], chars: 0 };
	const flush = async (): Promise<void> => {
		const { lines, owners } = pending;
		pending = { lines: [], owners: [], chars: 0 };
		const matched = [...(await matchTexts(lines, pattern, signal))].sort((a, b) => a - b);
		let last: object | undefined;
		for (const index of matched) {
			const owner = owners[index];
			// One hit per entry: its first matching line.
			if (owner === last) continue;
			last = owner;
			found.total++;
			if (found.hits.length < MAX_HITS) found.hits.push({ ...owner, line: lines[index] });
		}
	};
	for (const session of sessions) {
		signal?.throwIfAborted();
		if (Date.now() > deadline) {
			found.stopped = true;
			break;
		}
		if (
			!transcripts.stamp(db, session.id) ||
			sessionRows.byId(agent.db, session.id)?.workspace_id !== session.workspaceId
		) {
			found.unread++;
			continue;
		}
		let read = 0;
		let complete = true;
		for (const line of transcripts.entries(db, session.id)) {
			read += line.length;
			if (read >= 1024 * 1024) {
				read = 0;
				await setImmediate();
				if (Date.now() > deadline) {
					complete = false;
					break;
				}
			}
			const head = line.slice(0, HEAD_CHARS);
			if (!TESTED_TYPES.some((type) => head.includes(type))) continue;
			const entry: unknown = JSON.parse(line);
			const read_ = transcriptText(entry);
			const id = (entry as { id?: unknown }).id;
			if (!read_?.text || typeof id !== "string") continue;
			const owner = { session: session.id, entryId: id, role: read_.role, ...(read_.time ? { time: read_.time } : {}) };
			for (const text of read_.text.slice(0, ENTRY_CHARS).split("\n")) {
				if (!text) continue;
				pending.lines.push(text.slice(0, LINE_CHARS));
				pending.owners.push(owner);
				pending.chars += Math.min(text.length, LINE_CHARS);
			}
			if (pending.chars >= BATCH_CHARS) await flush();
		}
		if (!complete) {
			found.stopped = true;
			break;
		}
		found.scanned++;
	}
	if (pending.lines.length) await flush();
	return found;
}
