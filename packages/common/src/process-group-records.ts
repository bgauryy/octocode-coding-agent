import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ownStartAsync } from "./own-start.ts";
import { processStartAsync } from "./process-start.ts";

/**
 * Owner records for process groups a process starts and may leave behind when it dies without cleaning up (SIGKILL,
 * out of memory, a crash). The owner writes one record per group (group leader and owner each named by pid plus start
 * time, so a reused pid is never taken for them) and removes it on a clean close; a later process reaps the groups
 * whose owner is gone. Host-free: the caller supplies the folder.
 */

const SUFFIX = ".group.json";
const CLAIM = ".reaping-";
/** How long a group gets after SIGTERM before SIGKILL. */
const REAP_GRACE_MS = 2000;
const POLL_MS = 50;

export interface ProcessGroupRecord {
	/** The group leader's pid (also the group id). */
	pid: number;
	/** The leader's start time (`processStartAsync`); a record without one is never acted on. */
	started?: string;
	owner: { pid: number; started?: string };
	host: string;
	/** What the group runs, for the caller's report. */
	label: string;
}

/** A group stopped (or found and left alone) by `reapOrphanGroups`. */
export interface ReapedGroup {
	pid: number;
	label: string;
	stopped: boolean;
}

const fileFor = (dir: string, pid: number): string => path.join(dir, `${pid}${SUFFIX}`);

/** Writes the record of group `pid` owned by this process. Resolves to a function that removes it. */
export async function recordProcessGroup(dir: string, pid: number, label: string): Promise<() => void> {
	const [leader, owner] = await Promise.all([processStartAsync(pid), ownStartAsync()]);
	const record: ProcessGroupRecord = {
		pid,
		...(leader ? { started: leader.started } : {}),
		owner: { pid: process.pid, ...(owner ? { started: owner } : {}) },
		host: os.hostname(),
		label,
	};
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = fileFor(dir, pid);
	fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
	return () => fs.rmSync(file, { force: true });
}

function parse(text: string): ProcessGroupRecord | undefined {
	try {
		const value = JSON.parse(text) as Partial<ProcessGroupRecord>;
		const owner = value.owner;
		if (!Number.isInteger(value.pid) || (value.pid as number) <= 1) return undefined;
		if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) return undefined;
		if (typeof value.host !== "string" || typeof value.label !== "string") return undefined;
		return value as ProcessGroupRecord;
	} catch {
		return undefined;
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Whether `pid` is the process that recorded `started`: "same", "other" (gone or reused) or "unknown" (cannot tell). */
async function sameProcess(pid: number, started: string | undefined): Promise<"same" | "other" | "unknown"> {
	if (!alive(pid)) return "other";
	if (!started) return "unknown";
	const now = await processStartAsync(pid);
	if (!now) return alive(pid) ? "unknown" : "other";
	return now.zombie || now.started !== started ? "other" : "same";
}

async function stopGroup(pid: number): Promise<void> {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		return;
	}
	const deadline = Date.now() + REAP_GRACE_MS;
	while (groupAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	if (!groupAlive(pid)) return;
	// The group id is never reused while a member lives, so this reaches only what outlived the SIGTERM.
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// It exited between the check and the signal.
	}
}

/**
 * Stops the groups recorded in `dir` whose owner died without closing them, then removes their records. A group is
 * signalled only when its owner is provably gone (dead pid or a different start time) and its leader is provably the
 * recorded process (pid plus start time). Records of another host, of a live owner, and ones that cannot be judged
 * (no start time, `ps` failing) are left alone; a record whose leader is gone is removed without a signal, since the
 * group id may by now belong to someone else. Windows has no groups: nothing is reaped. Each record is claimed by a
 * rename first so two starting processes never both act on it.
 */
export async function reapOrphanGroups(dir: string): Promise<ReapedGroup[]> {
	if (process.platform === "win32") return [];
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((name) => name.endsWith(SUFFIX));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const found: ReapedGroup[] = [];
	for (const name of names) {
		const file = path.join(dir, name);
		const record = parse(fs.readFileSync(file, "utf8"));
		if (!record) continue;
		if (record.host !== os.hostname()) continue;
		if ((await sameProcess(record.owner.pid, record.owner.started)) !== "other") continue;
		const leader = await sameProcess(record.pid, record.started);
		if (leader === "unknown") continue;
		const claimed = `${file}${CLAIM}${process.pid}`;
		try {
			fs.renameSync(file, claimed);
		} catch {
			continue;
		}
		try {
			if (leader === "same") {
				await stopGroup(record.pid);
				found.push({ pid: record.pid, label: record.label, stopped: true });
			}
		} finally {
			fs.rmSync(claimed, { force: true });
		}
	}
	return found;
}
