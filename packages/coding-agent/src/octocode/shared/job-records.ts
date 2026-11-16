import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256 } from "../../../../common/src/atomic-file.ts";
import { validPid } from "../../utils/process-id.ts";
import { globalPaths, isSessionsTempDir } from "./home.ts";
import { groupAlive } from "./process.ts";

/** The owner records next to job logs (`files/bash-jobs/records.ts` writes and reaps them); `coordinate list` reads them too. */

/** A job's owner record: its log path with this suffix instead of `.log`. */
export const RECORD_SUFFIX = ".job.json";
/**
 * What a job's owner record holds: the job (pid plus start time names one process), the Octocode process that owns it and
 * the host both run on (pids mean nothing on another host sharing this folder; records from before it have none).
 */
export interface JobRecord {
	id: string;
	pid: number;
	started?: string;
	command: string;
	/** The backlog item the job serves, when its call named one. */
	item?: string;
	log: string;
	host?: string;
	owner: { pid: number; started?: string };
}

/** A checkout can supply arbitrary files. Keep process-signalling authority in private host state, separately from workspace logs. */
export const ownersRoot = () => path.join(globalPaths().agentState, "job-owners");
export function ownerDir(dir: string): string {
	const sessions = path.dirname(path.dirname(dir));
	return path.basename(dir) === "bash" && isSessionsTempDir(sessions) ? path.join(ownersRoot(), sha256(dir)) : dir;
}

export const recordFile = (log: string): string =>
	path.join(ownerDir(path.dirname(log)), path.basename(log).replace(/\.log$/, "") + RECORD_SUFFIX);

/** A readable owner record, else undefined. A pid of 1 or less would make a stop signal init, a group or everything. */
export function parseRecord(text: string): JobRecord | undefined {
	try {
		const record = JSON.parse(text) as JobRecord;
		return validPid(record.pid) && validPid(record.owner?.pid) && typeof record.log === "string" ? record : undefined;
	} catch {
		return undefined;
	}
}

export const readRecord = (file: string): JobRecord | undefined => {
	try {
		return parseRecord(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
};

/** Whether a record was written on another host: its processes cannot be judged from here. */
export const foreign = (record: JobRecord): boolean => record.host !== undefined && record.host !== os.hostname();

/**
 * The jobs running now from a `bash/` folder that name a backlog item (`item` of the bash call): what `coordinate list`
 * shows as work on that item. A record exists only while the job runs; one on another host or without a live process group is skipped.
 */
export function liveItemJobs(dir: string): { id: string; item: string }[] {
	const folder = ownerDir(dir);
	let names: string[];
	try {
		names = fs.readdirSync(folder).filter((name) => name.endsWith(RECORD_SUFFIX));
	} catch {
		return [];
	}
	return names.flatMap((name) => {
		const record = readRecord(path.join(folder, name));
		return record?.item && !foreign(record) && groupAlive(record.pid) ? [{ id: record.id, item: record.item }] : [];
	});
}
