import fs from "node:fs";
import path from "node:path";
import { getSessionsDir } from "../../config.ts";
import { SessionManager } from "../../core/session-manager.ts";
import type { AgentDb } from "../agentdb/db.ts";
import { runningPid } from "../agentdb/liveness.ts";
import { readMeta, writeMeta } from "../agentdb/meta.ts";
import { liveJobFiles } from "../files/bash-jobs/records.ts";
import { cleanupDays } from "../shared/env.ts";
import { PID_SESSION_PREFIX, sessionDirName, sessionsRoot } from "../shared/home.ts";
import { processAlive } from "../shared/process.ts";
import { sweepStaleOutputs } from "../shared/sweep.ts";
import { DAY_MS, HOUR_MS } from "../shared/util.ts";
import { shotsDir } from "../subagents/screenshots.ts";
import type { SessionExtra, SessionIndex } from "./store.ts";

/** The sweep runs at most this often across all sessions (meta `last_sweep`). */
const SWEEP_EVERY_MS = 6 * HOUR_MS;
/**
 * Ids of every session Octocode has a file for: in its default sessions dir and in each custom session dir a session ran from.
 * Octocode lists an unreadable dir as empty, so each dir is read first: a default dir that cannot be read (only a missing
 * one means no sessions yet), or a custom dir that turned unreadable since the sweep checked it, rejects, and the sweep
 * then removes nothing.
 */
async function sessionIds(dirs: readonly string[]): Promise<Set<string>> {
	const lists = await Promise.all([
		fs.promises.readdir(getSessionsDir()).then(
			() => SessionManager.listAll(),
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return [];
				throw error;
			},
		),
		...dirs.map(async (dir) => {
			await fs.promises.readdir(dir);
			return SessionManager.listAll(dir);
		}),
	]);
	return new Set(lists.flat().map((info) => info.id));
}

/**
 * Claims this sweep in the meta `last_sweep`: unless `force`, only when the last one is `SWEEP_EVERY_MS` old. The read and
 * the write share one write transaction, so of two processes starting at once only one claims. Returns the previous
 * claim (to give back), or undefined when another sweep holds it; throws when the database stays locked.
 */
export function claimSweep(agent: AgentDb, now: number, force: boolean): number | undefined {
	return agent.transaction(() => {
		const last = Number(readMeta(agent.db, "last_sweep") ?? 0);
		if (!force && now - last < SWEEP_EVERY_MS) return undefined;
		writeMeta(agent.db, "last_sweep", String(now));
		return last;
	});
}

/** Newest modification time among `files`; 0 when none exists. */
async function newestWrite(files: readonly string[]): Promise<number> {
	const times = await Promise.all(
		files.map((file) =>
			fs.promises.stat(file).then(
				(stat) => stat.mtimeMs,
				() => 0,
			),
		),
	);
	return Math.max(0, ...times);
}

/** Newest write in a session folder: the folder, its kind folders (the archive's included: a compaction is activity) and the checkpoint journal. 0 when it is missing. */
const lastWrite = (dir: string): Promise<number> =>
	newestWrite([
		dir,
		path.join(dir, "output"),
		path.join(dir, "bash"),
		path.join(dir, "archive"),
		path.join(dir, "checkpoints"),
		path.join(dir, "checkpoints", "journal.jsonl"),
	]);

/** Whether a session's checkpoints (journal, blobs) were last written more than `maxAgeMs` ago; false when there are none. */
async function checkpointsIdle(dir: string, maxAgeMs: number, now: number): Promise<boolean> {
	const newest = await newestWrite([dir, path.join(dir, "journal.jsonl"), path.join(dir, "blobs")]);
	return newest > 0 && now - newest > maxAgeMs;
}

/** Recorded session dirs that cannot be read now (unmounted, removed, no permission): their sessions cannot be listed. */
async function unreadableDirs(dirs: readonly string[]): Promise<Set<string>> {
	const readable = await Promise.all(
		dirs.map((dir) =>
			fs.promises.readdir(dir).then(
				() => true,
				() => false,
			),
		),
	);
	return new Set(dirs.filter((_, at) => !readable[at]));
}

/** Whether the session of `row` is open in a running process (`agentdb/liveness`); false without a row. */
const running = (row: SessionExtra | undefined) => runningPid(row?.pid, row?.pid_started) !== undefined;

const remove = (dir: string) => fs.promises.rm(dir, { recursive: true, force: true });

/** A session id's folder name, or none for a malformed id (`sessionDirName` refuses it): one bad row skips, not the sweep. */
function folderName(id: string): string[] {
	try {
		return [sessionDirName(id)];
	} catch {
		return [];
	}
}

/**
 * Removes Octocode data older than `OCTOCODE_CLEANUP_DAYS` (default 30; `0` turns the sweep off), at most once per
 * `SWEEP_EVERY_MS` (unless `force`): the folder and extras of a session Octocode no longer lists (a pid folder included)
 * unless its process is still running, and output and bash logs of the sessions kept (not a running job's record and log), checkpoints of a kept session
 * nothing wrote to, and subagent screenshots. A kept session's waiting reports (`reports/pending`) stay for its next start. The current session and Octocode's own session files are never touched. When Octocode's
 * listing (its default dir and the recorded custom session dirs it can read) fails nothing is removed. A recorded dir that cannot be
 * read keeps the sessions that ran from it, and those whose dir is unknown (older rows), while the rest is swept; it stays
 * recorded, so its sessions are listed again once it can be read. Returns the folder names removed. Never rejects.
 */
export async function sweepSessions(
	index: SessionIndex,
	current: string | undefined,
	options: {
		now?: number;
		force?: boolean;
		env?: NodeJS.ProcessEnv;
		listed?: (dirs: readonly string[]) => Promise<Set<string>>;
	} = {},
): Promise<string[]> {
	const now = options.now ?? Date.now();
	const env = options.env ?? process.env;
	const removed: string[] = [];
	// Spilled output, bash logs, idle checkpoints of a kept session, subagent screenshots, and the folders of sessions
	// Octocode no longer lists (deleted, a pid folder, a subagent's, whose spilled files its parent's report may still
	// cite) go this many days after their last write: one retention (`cleanupDays`), so a path in a kept transcript stays
	// readable as long as the session's own output does. The `archive` folder (compacted history) goes with its session's
	// folder, whose age counts its writes.
	const days = cleanupDays(env);
	if (days === 0) return removed;
	const outputMs = days * DAY_MS;
	try {
		// Claimed before the work, so concurrent session starts do not sweep twice; a failed listing gives the claim back.
		const last = claimSweep(index.agent, now, options.force ?? false);
		if (last === undefined) return removed;
		const dirs = index.sessionDirs();
		const unreadable = await unreadableDirs(dirs);
		let ids: Set<string>;
		try {
			ids = await (options.listed ?? sessionIds)(dirs.filter((dir) => !unreadable.has(dir)));
		} catch {
			writeMeta(index.agent.db, "last_sweep", String(last));
			return removed;
		}
		// A session in an unreadable dir is not listed but may still exist: it counts as listed. A row without a dir may be one.
		const unlistable = (row: SessionExtra) => unreadable.size > 0 && (row.dir === null || unreadable.has(row.dir));
		const rows = index.all();
		const listed = new Set([...ids, ...rows.filter(unlistable).map((row) => row.id)].flatMap(folderName));
		const extras = new Map(rows.flatMap((row) => folderName(row.id).map((name) => [name, row] as const)));
		const currentName = current ? folderName(current)[0] : undefined;
		const keep = new Set<string>(currentName ? [currentName] : []);
		const root = sessionsRoot(env);
		// Missing: no session folders yet.
		const names = await fs.promises.readdir(root).catch((): string[] => []);
		for (const name of names) {
			if (keep.has(name)) continue;
			const dir = path.join(root, name);
			const extra = extras.get(name);
			const pid = name.startsWith(PID_SESSION_PREFIX) ? Number(name.slice(PID_SESSION_PREFIX.length)) : undefined;
			const stale =
				pid !== undefined
					? // A `_pid-<n>` folder names its process; no session row (or team row) exists for a session-less process.
						pid !== process.pid && !processAlive(pid) && now - (await lastWrite(dir)) > outputMs
					: !listed.has(name) && !running(extra) && now - (await lastWrite(dir)) > outputMs;
			if (stale) {
				await remove(dir);
				if (extra) index.forget(extra.id);
				removed.push(name);
			} else keep.add(name);
		}
		// Extras of a session with neither a Octocode file nor a folder left are dead weight.
		const present = new Set(names);
		for (const [name, extra] of extras) {
			if (!keep.has(name) && !listed.has(name) && !present.has(name) && !running(extra)) index.forget(extra.id);
		}
		for (const name of keep) {
			await sweepStaleOutputs(path.join(root, name, "output"), outputMs, undefined, now);
			// A running job's owner record is written once at its start: its age says nothing, and its log is still open.
			const bash = path.join(root, name, "bash");
			await sweepStaleOutputs(bash, outputMs, await liveJobFiles(bash), now);
			// A session's checkpoints go whole (a journal pointing at removed blobs only makes a rewind skip files), and only
			// when nothing wrote to them for the period: resuming a session protects it, since it is then the current one.
			const checkpoints = path.join(root, name, "checkpoints");
			if (name !== currentName && !running(extras.get(name)) && (await checkpointsIdle(checkpoints, outputMs, now)))
				await remove(checkpoints);
		}
		await sweepStaleOutputs(shotsDir(env), outputMs, undefined, now);
	} catch {
		// A sweep is housekeeping: whatever it could not remove, the next one tries again.
	}
	return removed;
}
