import fs from "node:fs";
import path from "node:path";
import { type Retention, resolveRetention } from "../../storage/retention.ts";
import type { SessionExtra } from "../../../../db/src/api.ts";
import { mayRemoveArchive } from "../archive/retention.ts";
import { liveJobFiles } from "../files/bash-jobs/records.ts";
import { PID_SESSION_PREFIX } from "../shared/home.ts";
import { processAlive } from "../shared/process.ts";
import { staleEntries } from "../shared/sweep.ts";
import { DAY_MS } from "../shared/util.ts";
import { shotsDir } from "../subagents/screenshots.ts";
import { idleSince, pathSize, realDirectory } from "./sweep-fs.ts";
import { namedByCheckpoint } from "./sweep-named.ts";
import {
	folderName,
	running,
	scanTranscripts,
	type SweepScope,
	sessionIds,
	sweepScopes,
	type Transcript,
	unreadableDirs,
} from "./sweep-listing.ts";
import type { SweepCandidate, SweepPlan } from "./sweep-types.ts";
import type { SessionIndex } from "./store.ts";

export interface PlanOptions {
	now?: number;
	env?: NodeJS.ProcessEnv;
	/** Default: `resolveRetention(env)`. */
	retention?: Retention;
	listed?: (dirs: readonly string[]) => Promise<Set<string>>;
}

/** Newest write in a session folder: the folder, its kind folders (the archive's included: a compaction is activity) and the checkpoint journal. 0 when missing. */
async function lastWrite(dir: string): Promise<number> {
	const files = [
		dir,
		path.join(dir, "output"),
		path.join(dir, "bash"),
		path.join(dir, "archive"),
		path.join(dir, "checkpoints"),
		path.join(dir, "checkpoints", "journal.jsonl"),
	];
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

/** Whether a session's checkpoints (journal, blobs) were last written more than `maxAgeMs` ago; false when there are none. */
async function checkpointsIdle(dir: string, maxAgeMs: number, now: number): Promise<boolean> {
	const times = await Promise.all(
		[dir, path.join(dir, "journal.jsonl"), path.join(dir, "blobs")].map((file) =>
			fs.promises.stat(file).then(
				(stat) => stat.mtimeMs,
				() => 0,
			),
		),
	);
	const newest = Math.max(0, ...times);
	return newest > 0 && now - newest > maxAgeMs;
}

const daysAgo = (now: number, at: number) => Math.floor((now - at) / DAY_MS);

/**
 * Decides what one pass removes, without removing anything: every candidate with its path, reason and size, the
 * sessions whose database rows go, and the roots it skipped. Rejects when Octocode's session listing fails (nothing is
 * planned then). Usable from a script: `planSweep(new SessionIndex(sharedAgentDb()), undefined)`.
 *
 * Rules, per `resolveRetention` (`0` turns a rule off): `days` for a session's folder when Octocode no longer lists it
 * (and no process runs it), stale output and bash logs, idle checkpoints, subagent screenshots and old
 * `<workspace>/.octocode/agent/tmp` entries (an output or bash log the session's latest checkpoint names stays); `sessionDays` for a transcript whose last write is older, with its session folders
 * and database rows. The current session, running sessions, a recorded directory that cannot be read, and a live bash
 * job are never touched.
 */
export async function planSweep(
	index: SessionIndex,
	current: string | undefined,
	options: PlanOptions = {},
): Promise<SweepPlan> {
	const now = options.now ?? Date.now();
	const env = options.env ?? process.env;
	const retention = options.retention ?? resolveRetention(env);
	const plan: SweepPlan = { at: now, retention, candidates: [], forgets: [], orphans: [], skipped: [] };
	const { days, sessionDays } = retention;
	if (days === 0 && sessionDays === 0) return plan;
	const outputMs = days * DAY_MS;
	const sessionMs = sessionDays * DAY_MS;

	const dirs = index.sessionDirs();
	const unreadable = await unreadableDirs(dirs);
	const ids = await (options.listed ?? sessionIds)(dirs.filter((dir) => !unreadable.has(dir)));
	const { scopes, skipped } = await sweepScopes(index.agent.db, env);
	plan.skipped.push(...skipped);

	const rows = index.all();
	const byId = new Map(rows.map((row) => [row.id, row] as const));
	const extras = new Map(rows.flatMap((row) => folderName(row.id).map((name) => [name, row] as const)));
	// A session in an unreadable dir is not listed but may still exist: it counts as listed. A row without a dir may be one.
	const unlistable = (row: SessionExtra) => unreadable.size > 0 && (row.dir === null || unreadable.has(row.dir));
	const listedIds = new Set([...ids, ...rows.filter(unlistable).map((row) => row.id)]);

	// Phase 1: every scope's transcripts, so a session found in any workspace counts as listed everywhere.
	const scanned: { scope: SweepScope; files: Transcript[] }[] = [];
	for (const scope of scopes) {
		const { files, unreadable: bad } = await scanTranscripts(scope);
		if (bad) {
			plan.skipped.push({ path: bad, reason: "transcript directory cannot be read; its sessions are kept" });
			for (const file of files) listedIds.add(file.id);
			continue;
		}
		for (const file of files) listedIds.add(file.id);
		scanned.push({ scope, files });
	}
	const listed = new Set([...listedIds].flatMap(folderName));
	const currentName = current ? folderName(current)[0] : undefined;

	const add = async (candidate: Omit<SweepCandidate, "bytes">) => {
		plan.candidates.push({ ...candidate, bytes: await pathSize(candidate.path) });
	};
	const expired = new Set<string>();
	const kept = new Set<string>(currentName ? [currentName] : []);
	const present = new Set<string>();

	for (const { scope, files } of scanned) {
		// Transcripts past `sessionDays`, with the session's folders and rows.
		if (sessionDays > 0) {
			for (const file of files) {
				const row = byId.get(file.id);
				if (now - file.mtime <= sessionMs || file.id === current || running(row)) continue;
				const name = folderName(file.id)[0];
				const folders = name ? scope.folderRoots.map((root) => path.join(root, name)) : [];
				const existing: string[] = [];
				let removable = true;
				for (const folder of folders) {
					if (!(await realDirectory(folder))) continue;
					existing.push(folder);
					if (!(await mayRemoveArchive(index.agent, path.join(folder, "archive"), env, now, { dropsRows: true })))
						removable = false;
				}
				if (!removable) continue;
				const reason = `transcript idle ${daysAgo(now, file.mtime)} days (sessionDays ${sessionDays})`;
				for (const folder of existing) {
					await add({ kind: "session-folder", path: folder, root: path.dirname(folder), reason, session: file.id });
				}
				await add({
					kind: "transcript",
					path: file.file,
					root: file.dir,
					reason,
					session: file.id,
					mtime: file.mtime,
				});
				plan.forgets.push({ id: file.id, reason });
				if (name) expired.add(name);
			}
		}
	}

	if (days > 0) {
		for (const { scope } of scanned) {
			if (!scope.durable || !scope.temp) continue;
			const roots = [...new Set([scope.durable, scope.temp])];
			const entries = await Promise.all(
				roots.map((folder) => fs.promises.readdir(folder, { withFileTypes: true }).catch(() => [])),
			);
			const names = new Set(
				entries
					.flat()
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name),
			);
			for (const name of names) {
				if (expired.has(name)) continue;
				present.add(name);
				if (name === currentName) continue;
				const folders = [...new Set(roots.map((root) => path.join(root, name)))];
				const stats = await Promise.all(folders.map((folder) => fs.promises.lstat(folder).catch(() => undefined)));
				if (stats.some((stat) => stat && !stat.isDirectory())) continue;
				const last = Math.max(...(await Promise.all(folders.map(lastWrite))));
				const extra = extras.get(name);
				const pid = name.startsWith(PID_SESSION_PREFIX) ? Number(name.slice(PID_SESSION_PREFIX.length)) : undefined;
				// A `_pid-<n>` folder names its process; no session row (or team row) exists for a session-less process.
				const stale =
					pid !== undefined
						? pid !== process.pid && !processAlive(pid) && now - last > outputMs
						: !listed.has(name) && !running(extra) && now - last > outputMs;
				if (stale && (await mayRemoveArchive(index.agent, path.join(scope.durable, name, "archive"), env, now))) {
					const reason = `${pid === undefined ? "session no longer listed" : "process ended"}, idle ${daysAgo(now, last)} days (days ${days})`;
					for (const folder of folders) {
						if (stats[folders.indexOf(folder)])
							await add({
								kind: "session-folder",
								path: folder,
								root: path.dirname(folder),
								reason,
								idleBefore: now - outputMs,
								...(pid === undefined ? {} : { pid }),
								...(extra ? { session: extra.id } : {}),
							});
					}
					if (extra) plan.forgets.push({ id: extra.id, reason });
				} else kept.add(name);
			}
			for (const name of kept) {
				if (!names.has(name)) continue;
				const owner = extras.get(name);
				const own = owner ? { session: owner.id } : {};
				const cutoff = now - outputMs;
				const output = path.join(scope.temp, name, "output");
				const bash = path.join(scope.temp, name, "bash");
				const staleOutput = await staleEntries(output, outputMs, undefined, now);
				// A running job's owner record is written once at its start: its age says nothing, and its log is still open.
				const staleBash = await staleEntries(bash, outputMs, await liveJobFiles(bash), now);
				// A file the session's latest checkpoint still points the model to is evidence, however old: it goes with the session.
				const named = await namedByCheckpoint(index.agent, owner?.id, [...staleOutput, ...staleBash]);
				for (const file of staleOutput.filter((entry) => !named.has(entry)))
					await add({
						kind: "output",
						path: file,
						root: output,
						reason: `output idle over ${days} days`,
						idleBefore: cutoff,
						...own,
					});
				for (const file of staleBash.filter((entry) => !named.has(entry)))
					await add({
						kind: "output",
						path: file,
						root: bash,
						reason: `bash log idle over ${days} days`,
						idleBefore: cutoff,
						...own,
					});
				// A session's checkpoints go whole (a journal pointing at removed blobs only makes a rewind skip files), and only
				// when nothing wrote to them for the period: resuming a session protects it, since it is then the current one.
				const checkpoints = path.join(scope.durable, name, "checkpoints");
				if (name !== currentName && !running(extras.get(name)) && (await checkpointsIdle(checkpoints, outputMs, now)))
					await add({
						kind: "checkpoints",
						path: checkpoints,
						root: path.join(scope.durable, name),
						reason: `checkpoints idle over ${days} days`,
						idleBefore: cutoff,
						...own,
					});
			}
			// Only `agent/tmp`: other `agent/<topic>/` folders hold durable output.
			if (scope.scratch) {
				const tmpNames = await fs.promises.readdir(scope.scratch).catch((): string[] => []);
				for (const tmpName of tmpNames) {
					const entry = path.join(scope.scratch, tmpName);
					if (await idleSince(entry, now - outputMs))
						await add({
							kind: "scratch",
							path: entry,
							root: scope.scratch,
							reason: `scratch idle over ${days} days`,
							idleBefore: now - outputMs,
						});
				}
			}
		}
		const shots = shotsDir(env);
		for (const file of await staleEntries(shots, outputMs, undefined, now))
			await add({
				kind: "output",
				path: file,
				root: shots,
				reason: `screenshot idle over ${days} days`,
				idleBefore: now - outputMs,
			});

		// Extras of a session with neither an Octocode file nor a folder left are dead weight. Only rows of a workspace this
		// pass read in full (or of none) are judged: a missing or unreadable checkout may still hold the transcript.
		// `forget` keeps a row that still has a transcript mirror or compaction summary; the rest are dropped.
		const seenWorkspaces = new Set(scanned.flatMap(({ scope }) => (scope.workspaceId ? [scope.workspaceId] : [])));
		const planned = new Set(plan.forgets.map((entry) => entry.id));
		// A row that still names a transcript file keeps its mirror: the database's own orphan rule ages it out.
		const withFile = new Set(index.catalog().map((row) => row.id));
		for (const [name, extra] of extras) {
			const known = !withFile.has(extra.id) && (!extra.workspace_id || seenWorkspaces.has(extra.workspace_id));
			const orphan = !listedIds.has(extra.id) && !running(extra) && extra.id !== current;
			if (orphan && (!extra.workspace_id || seenWorkspaces.has(extra.workspace_id))) plan.orphans.push(extra.id);
			if (
				known &&
				!planned.has(extra.id) &&
				!kept.has(name) &&
				!listed.has(name) &&
				!present.has(name) &&
				!running(extra)
			)
				plan.forgets.push({ id: extra.id, reason: "no transcript and no session folder left" });
		}
	}
	return plan;
}
