import { randomBytes } from "node:crypto";
import type { AgentDb } from "../db.ts";
import * as transcripts from "../queries/transcripts.ts";

/**
 * A full transcript save (`save` command) in bounded steps. The stored entries are compared with the new ones first,
 * outside the write lock, so only what differs is written: the stored rows past the common prefix are deleted and the
 * new rows past it inserted. A large difference is written in several transactions of at most `CHUNK_ROWS` rows or
 * `CHUNK_BYTES` bytes, with a pause between them, so another connection (the main thread's, another process's) waits for
 * one step, not for the whole save.
 *
 * Between steps the stored rows are a prefix of the old or of the new transcript: the state of a mirror that is behind,
 * which every reader already handles. The row's stamp then carries a marker (`<mtime>~<token>`) that never equals a
 * file's stamp, so no one takes the partial copy as level; only the last step writes the real stamp. A step that finds
 * another marker or stamp stops: another writer saved this transcript meanwhile.
 */

const CHUNK_ROWS = 200;
const CHUNK_BYTES = 512 * 1024;

/** How a stepped save lets other connections in between its transactions (the writer thread sleeps briefly). */
export interface SaveSteps {
	pause(): void;
}

export interface SaveTarget {
	sessionId: string;
	file: string;
	header: string;
	stamp: { size: number; mtime: string; binding: string };
	records: readonly transcripts.EntryRow[];
}

type Stored = ReturnType<typeof transcripts.stamp>;

/** What the stored rows share with `target`, read before the write lock (`storedPrefix`). */
export type SavePlan = ReturnType<typeof transcripts.storedPrefix>;

export function planSave(agent: AgentDb, target: SaveTarget): SavePlan {
	return transcripts.storedPrefix(
		agent.db,
		target.sessionId,
		target.records.map((record) => record.json),
	);
}

const sameStamp = (a: Stored, b: Stored) =>
	a === b ||
	(a !== undefined &&
		b !== undefined &&
		a.file === b.file &&
		a.byte_size === b.byte_size &&
		a.mtime === b.mtime &&
		a.file_binding === b.file_binding);

interface Cursor {
	/** Stored rows from here on are still to be deleted (down to `common`). */
	end: number;
	/** The next new record to insert. */
	next: number;
	readonly common: number;
}

/** One step's work: delete the old tail from its end, then insert the new tail, within the bounds. Returns true when done. */
function advance(agent: AgentDb, target: SaveTarget, cursor: Cursor, bounded: boolean): boolean {
	let rows = 0;
	let bytes = 0;
	const full = () => bounded && (rows >= CHUNK_ROWS || bytes >= CHUNK_BYTES);
	if (cursor.end > cursor.common) {
		const from = bounded ? Math.max(cursor.common, cursor.end - CHUNK_ROWS) : cursor.common;
		transcripts.deleteEntriesFrom(agent.db, target.sessionId, from);
		rows += cursor.end - from;
		cursor.end = from;
		if (cursor.end > cursor.common) return false;
	}
	const batch: { position: number; record: transcripts.EntryRow }[] = [];
	while (cursor.next < target.records.length && !full()) {
		const record = target.records[cursor.next];
		batch.push({ position: cursor.next, record });
		rows += 1;
		bytes += record.json.length;
		cursor.next += 1;
	}
	transcripts.insertEntries(agent.db, target.sessionId, batch);
	return cursor.next >= target.records.length;
}

/**
 * Inside the command's first write transaction, after its checks: saves `target`, all at once when the difference is
 * small (or `steps` is undefined), else its first step. Returns the remaining steps to run, or undefined when done.
 * `previous` is the stamp read in this transaction; a plan read from another stamp is not used (everything is replaced).
 */
export function startSave(
	agent: AgentDb,
	target: SaveTarget,
	previous: Stored,
	plan: SavePlan | undefined,
	steps: SaveSteps | undefined,
): (() => "saved" | "current" | "skipped") | undefined {
	const usable = plan !== undefined && previous !== undefined && sameStamp(plan.stamp, previous);
	const common = usable ? plan.common : 0;
	const cursor: Cursor = { end: usable ? plan.stored : 0, next: common, common };
	if (!usable) transcripts.deleteEntriesFrom(agent.db, target.sessionId, 0);
	const rows = cursor.end - common + (target.records.length - common);
	let bytes = 0;
	for (let n = common; n < target.records.length && bytes < CHUNK_BYTES; n++) bytes += target.records[n].json.length;
	if (!steps || (rows <= CHUNK_ROWS && bytes < CHUNK_BYTES)) {
		transcripts.writeStamp(agent.db, target.sessionId, target.file, target.header, target.stamp, previous?.file);
		advance(agent, target, cursor, false);
		return undefined;
	}
	const marker = { ...target.stamp, mtime: `${target.stamp.mtime}~${randomBytes(6).toString("hex")}` };
	transcripts.writeStamp(agent.db, target.sessionId, target.file, target.header, marker, previous?.file);
	if (advance(agent, target, cursor, true)) {
		transcripts.writeStamp(agent.db, target.sessionId, target.file, target.header, target.stamp, target.file);
		return undefined;
	}
	return () => {
		for (;;) {
			steps.pause();
			const outcome = agent.transaction(() => {
				const stored = transcripts.stamp(agent.db, target.sessionId);
				if (!stored) return "skipped";
				if (stored.file !== target.file || stored.mtime !== marker.mtime) return "current";
				if (!advance(agent, target, cursor, true)) return undefined;
				transcripts.writeStamp(agent.db, target.sessionId, target.file, target.header, target.stamp, target.file);
				return "saved";
			});
			if (outcome) return outcome;
		}
	};
}
