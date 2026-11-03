import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimSuffix, releaseDeadClaims } from "../../shared/claims.ts";
import { sha256 } from "../../../../../common/src/atomic-file.ts";
import { WORKSPACE_STATE } from "../../../config/workspace.ts";
import { currentSessionWorkspace, globalPaths, sessionTempRoot } from "../../shared/home.ts";
import {
	groupAlive,
	groupStartTimes,
	processAlive,
	processMatch,
	sameProcess,
	stopTree,
} from "../../shared/process.ts";
import { validPid } from "../../../utils/process-id.ts";

/** Owner records next to job logs, and stopping the jobs of an Octocode that died without ending them. */

/** A job's owner record: its log path with this suffix instead of `.log`. */
const RECORD_SUFFIX = ".job.json";
/** A record being reaped is renamed `<record>.reaping-<pid>-<start time>` by the Octocode that claimed it (`shared/claims.ts`). */
const CLAIM_MARKER = ".reaping-";

/**
 * What a job's owner record holds: the job (pid plus start time names one process), the Octocode process that owns it and
 * the host both run on (pids mean nothing on another host sharing this folder; records from before it have none).
 */
export interface JobRecord {
	id: string;
	pid: number;
	started?: string;
	command: string;
	log: string;
	host?: string;
	owner: { pid: number; started?: string };
}

/** A job found running after its Octocode died; `stopped` is false when it could not be confirmed as the recorded process. */
export interface OrphanJob {
	id: string;
	pid: number;
	command: string;
	log: string;
	stopped: boolean;
}

/** A checkout can supply arbitrary files. Keep process-signalling authority in private host state, separately from workspace logs. */
const ownersRoot = () => path.join(globalPaths().agentState, "job-owners");
function ownerDir(dir: string): string {
	const sessions = path.dirname(path.dirname(dir));
	return path.basename(dir) === "bash" && sessions.endsWith(path.sep + path.join(WORKSPACE_STATE, "temp", "sessions"))
		? path.join(ownersRoot(), sha256(dir))
		: dir;
}

export const recordFile = (log: string): string =>
	path.join(ownerDir(path.dirname(log)), path.basename(log).replace(/\.log$/, "") + RECORD_SUFFIX);

/** A readable owner record, else undefined. A pid of 1 or less would make a stop signal init, a group or everything. */
function parseRecord(text: string): JobRecord | undefined {
	try {
		const record = JSON.parse(text) as JobRecord;
		return validPid(record.pid) && validPid(record.owner?.pid) && typeof record.log === "string" ? record : undefined;
	} catch {
		return undefined;
	}
}

const readRecord = (file: string): JobRecord | undefined => {
	try {
		return parseRecord(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};

/** Whether a record was written on another host: its processes cannot be judged from here. */
const foreign = (record: JobRecord): boolean => record.host !== undefined && record.host !== os.hostname();

/**
 * Names in a `bash/` folder that belong to jobs whose Octocode still runs (or runs on another host, which cannot be judged
 * here): their owner records and logs (with a rotated `.1`), which the session sweep must not age out. The record is
 * written once at the job's start, so its age says nothing about the job. A record that cannot be read is kept, with the
 * log its name points at (`recordFile`): a job that cannot be judged is not one to sweep. A record that reads but does
 * not parse is garbage and ages out. Never rejects.
 */
export async function liveJobFiles(dir: string): Promise<Set<string>> {
	const live = new Set<string>();
	const folder = ownerDir(dir);
	const names = await fs.promises.readdir(folder).catch((): string[] => []);
	for (const name of names.filter((each) => each.endsWith(RECORD_SUFFIX))) {
		const text = await fs.promises.readFile(path.join(folder, name), "utf8").catch(() => undefined);
		const record = text === undefined ? undefined : parseRecord(text);
		if (text !== undefined && (!record || (!foreign(record) && !sameProcess(record.owner.pid, record.owner.started))))
			continue;
		const log = record ? path.basename(record.log) : `${name.slice(0, -RECORD_SUFFIX.length)}.log`;
		for (const each of [name, log, `${log}.1`]) live.add(each);
	}
	return live;
}

/** Every session's `bash/` folder (most do not exist; the reader skips those). */
export function sessionBashDirs(): string[] {
	const bound = currentSessionWorkspace() !== undefined;
	const root = bound ? ownersRoot() : sessionTempRoot();
	try {
		return fs
			.readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => (bound ? path.join(root, entry.name) : path.join(root, entry.name, "bash")));
	} catch {
		return [];
	}
}

/**
 * Stops background jobs whose Octocode died without ending them (kill -9, out of memory): owner records in `dirs` whose
 * owner process is gone. Killing an unrelated process is the worst outcome, so a job is stopped (SIGTERM, then
 * SIGKILL) only on proof: its shell is the recorded process (pid plus start time), or its shell is gone, its group
 * outlived it, every member started at or after the job, and no later record names the pid (it was not reused). A
 * record from another host is not ours to judge and stays. Each record is claimed by a rename first, so two Pis
 * starting at once never both act on it, and is removed after; a claim whose Octocode died is retried. Anything that cannot
 * be judged (no start time recorded, `ps` failing) is left alone and returned with `stopped: false`; a record that
 * `ps` could not judge is kept for a later start to retry.
 */
export async function reapOrphanJobs(dirs: readonly string[]): Promise<OrphanJob[]> {
	const found: OrphanJob[] = [];
	const stops: Array<Promise<void>> = [];
	const entries: Array<{ file: string; record: JobRecord | undefined }> = [];
	for (const input of dirs) {
		const dir = ownerDir(input);
		try {
			await releaseDeadClaims(dir, fs.readdirSync(dir), CLAIM_MARKER, (original) => original.endsWith(RECORD_SUFFIX));
			for (const name of fs.readdirSync(dir))
				if (name.endsWith(RECORD_SUFFIX))
					entries.push({ file: path.join(dir, name), record: readRecord(path.join(dir, name)) });
		} catch {
			// A folder that cannot be listed (gone, no permission) holds no records we can judge: skip it, keep reaping the others.
		}
	}
	// The latest recorded start of each job pid on this host: a later job with the same pid means ours ended before it.
	const latest = new Map<number, number>();
	for (const { record } of entries) {
		if (record && !foreign(record) && /^\d+$/.test(record.started ?? ""))
			latest.set(record.pid, Math.max(latest.get(record.pid) ?? 0, Number(record.started)));
	}
	for (const { file, record } of entries) {
		if (record && (foreign(record) || sameProcess(record.owner.pid, record.owner.started))) continue;
		const claimed = `${file}${claimSuffix(CLAIM_MARKER)}`;
		try {
			fs.renameSync(file, claimed);
		} catch {
			continue;
		}
		let keep = false;
		if (record) {
			const job = { id: record.id, pid: record.pid, command: record.command, log: record.log };
			const verdict = orphanVerdict(record, latest);
			if (verdict === "stop") stops.push(stopTree(record.pid));
			if (verdict !== "gone") found.push({ ...job, stopped: verdict === "stop" });
			keep = verdict === "retry";
		}
		try {
			if (keep) fs.renameSync(claimed, file);
			else fs.rmSync(claimed, { force: true });
		} catch {
			// A later start finds the claim of a gone Octocode and retries it.
		}
	}
	await Promise.all(stops);
	return found;
}

/**
 * What to do with the job of a dead owner: `stop` it, leave it alone (`leave`; `retry` keeps the record because `ps`
 * failed), or nothing (`gone`: it ended, or its pid now names another process).
 */
function orphanVerdict(record: JobRecord, latest: ReadonlyMap<number, number>): "stop" | "leave" | "retry" | "gone" {
	const match = processMatch(record.pid, record.started);
	if (match === "same") return "stop";
	if (match === "unknown") return record.started ? "retry" : "leave";
	if (processAlive(record.pid) || !groupAlive(record.pid)) return "gone";
	// The shell is gone but its group lives (`server &`). A group id is never reused while a member lives, yet the job's
	// group may have ended long ago and its pid been reused as another group's leader: only a group whose members all
	// started at or after the job, with no later job recorded under that pid, is taken for the job's.
	if (!/^\d+$/.test(record.started ?? "") || (latest.get(record.pid) ?? 0) > Number(record.started)) return "leave";
	const members = groupStartTimes(record.pid);
	if (members === undefined) return "retry";
	return members.length > 0 && members.every((member) => Number(member.started) >= Number(record.started))
		? "stop"
		: "leave";
}
