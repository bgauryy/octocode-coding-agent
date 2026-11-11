import fs from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { shortHash } from "../../../../common/src/atomic-file.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { type AgentDb, compactions, meta, sessions } from "../../../../db/src/api.ts";
import type { HistoryRepair } from "./repair.ts";

/**
 * The retention sweep repairs every cataloged transcript (`retention.ts`), and an `archive` read repairs the sessions it
 * reads (`repairBeforeRead`). A transcript repaired completely, which has not changed since, holds nothing new: its
 * stamp is kept in meta `archive_repair_stamps` (file → stamp) and the next sweep or read skips it without reading it. The stamp is the file's size, modification time and inode, with a hash of the
 * session's compaction rows taken after the repair: a row removed or changed elsewhere (a purge) repairs the file again.
 * A repair counts as complete when the transcript has no compaction entries or their origin is verified, and every row
 * of its session is verified with its detail copy present or expired; anything less is tried again at every sweep.
 */
const KEY = "archive_repair_stamps";

function savedStamps(agent: AgentDb): Map<string, string> {
	try {
		const value: unknown = JSON.parse(meta.read(agent.db, KEY) ?? "{}");
		if (typeof value !== "object" || value === null || Array.isArray(value)) return new Map();
		return new Map(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
	} catch {
		return new Map();
	}
}

async function fileStamp(file: string): Promise<string | undefined> {
	const stat = await fs.promises.stat(file, { bigint: true }).catch(() => undefined);
	return stat?.isFile() ? `${stat.size}:${stat.mtimeNs}:${stat.ino}` : undefined;
}

/** The session's compaction rows as repair leaves them, or undefined when one still needs a repair to finish it. */
function rowsDigest(agent: AgentDb, sessionId: string): string | undefined {
	const rows = compactions.forSession(agent.db, sessionId);
	if (rows.some((row) => !row.originVerified || row.detailState === "missing")) return undefined;
	return shortHash(
		JSON.stringify(rows.map((row) => [row.entryId, row.detailState, row.detailFile, row.committedAt, row.summary])),
	);
}

/**
 * Repair every cataloged transcript that changed since its last complete repair, one at a time, letting the event loop
 * run between them. A failed repair keeps that session's details until a later sweep succeeds.
 */
export async function repairCatalog(agent: AgentDb, repair: HistoryRepair): Promise<void> {
	const before = savedStamps(agent);
	const after = new Map<string, string>();
	for (const session of sessions.catalog(agent.db)) {
		await nextTurn();
		const file = session.file;
		if (!file) continue;
		const stamp = await fileStamp(file);
		const known = before.get(file);
		if (stamp && known?.startsWith(`${stamp}:`) && known === `${stamp}:${rowsDigest(agent, session.id)}`) {
			after.set(file, known);
			continue;
		}
		try {
			const result = await repair.transcript(file);
			// Without entries, nothing waits for its origin to be proven.
			const complete = result !== undefined && (result.verified || result.entries === 0);
			const digest = complete ? rowsDigest(agent, session.id) : undefined;
			// The stamp taken before the read: a change made during it makes the next sweep read the file again.
			if (stamp && digest) after.set(file, `${stamp}:${digest}`);
		} catch {
			/* This session's details remain until repair succeeds. */
		}
	}
	try {
		meta.write(agent.db, KEY, JSON.stringify(Object.fromEntries(after)));
	} catch {
		/* Unsaved stamps only mean the next sweep reads these transcripts again. */
	}
}

/** Whether a repair result leaves nothing to retry: no compaction entries, or entries whose origin is proven. */
const completed = (result: { verified: boolean; entries: number } | undefined): boolean =>
	result !== undefined && (result.verified || result.entries === 0);

/**
 * This process's reads of its own session's transcript, which grows with every turn: the file's identity and the offset
 * just past the last whole line a complete repair read. The next read starts there, so it reads only what was appended.
 */
const readTo = new Map<string, { identity: string; end: number }>();

/** Repairs what this session's transcript added since the last complete repair in this process. */
async function repairCurrent(repair: HistoryRepair, file: string): Promise<void> {
	const stat = await fs.promises.stat(file, { bigint: true }).catch(() => undefined);
	if (!stat?.isFile()) return;
	const identity = `${stat.dev}:${stat.ino}`;
	const known = readTo.get(file);
	const from = known?.identity === identity && BigInt(known.end) <= stat.size ? known.end : 0;
	if (from > 0 && BigInt(from) === stat.size) return;
	readTo.delete(file);
	const result = await repair.transcript(file, from);
	// An incomplete repair (an origin not yet proven) reads the whole file again next time.
	if (result && completed(result)) readTo.set(file, { identity, end: result.end });
}

/**
 * Transcripts of other sessions this process repaired or found stamped before a read, at the file stamp it saw: while
 * the file is unchanged a later read neither reads it nor checks its rows again.
 */
const checked = new Map<string, string>();

/** A session in the history a read covers: its archive folder and the transcript its record names. */
interface RepairTarget {
	id: string;
	folder: string;
	transcript?: string;
}

/**
 * The repair an `archive` read runs first, so the compaction rows it reads are complete: this session's transcript from
 * where the last read ended, then each session in scope whose transcript changed since its last complete repair (by its
 * stamp; an unchanged one is not read). Returns a coverage line for each repair that failed; the read goes on.
 */
export async function repairBeforeRead(
	agent: AgentDb,
	repair: HistoryRepair,
	current: string | undefined,
	scope: readonly RepairTarget[],
	signal?: AbortSignal,
): Promise<string[]> {
	const gaps: string[] = [];
	const attempt = async (run: () => Promise<void>) => {
		signal?.throwIfAborted();
		try {
			await run();
		} catch (error) {
			signal?.throwIfAborted();
			gaps.push(`Historical recovery incomplete: ${errorMessage(error)}`);
		}
	};
	if (current) await attempt(() => repairCurrent(repair, current));
	const before = savedStamps(agent);
	const after = new Map<string, string>();
	// A session's record names its transcript; one that names none has nothing to repair. This session's own was read above.
	const targets = scope.filter(
		(session): session is RepairTarget & { transcript: string } =>
			!!session.transcript && session.transcript !== current,
	);
	const stamps = await Promise.all(targets.map((session) => fileStamp(session.transcript)));
	for (const [index, session] of targets.entries()) {
		const file = session.transcript;
		const stamp = stamps[index];
		if (stamp && checked.get(file) === stamp) continue;
		const known = before.get(file);
		if (stamp && known?.startsWith(`${stamp}:`) && known === `${stamp}:${rowsDigest(agent, session.id)}`) {
			checked.set(file, stamp);
			continue;
		}
		await attempt(async () => {
			const result = await repair.archive(session.folder);
			const digest = completed(result) ? rowsDigest(agent, session.id) : undefined;
			if (result && stamp && digest && result.file === file) after.set(file, `${stamp}:${digest}`);
			// Unchanged, it gives the same result again: the retention sweep retries an incomplete one.
			if (stamp) checked.set(file, stamp);
		});
	}
	if (after.size > 0) {
		try {
			// Merged into the stamps saved now: a sweep or another read may have written since they were read above.
			meta.write(
				agent.db,
				KEY,
				JSON.stringify({ ...Object.fromEntries(savedStamps(agent)), ...Object.fromEntries(after) }),
			);
		} catch {
			/* Unsaved stamps only mean the next read repairs these transcripts again. */
		}
	}
	return gaps;
}
