import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { atomicWriteFileSync } from "@octocodeai/octocode-common/atomic-file";
import { processLifetime } from "@octocodeai/octocode-common/process-lifetime";
import { globalPaths } from "../shared/home.ts";
import { processAlive } from "../shared/process.ts";

/** Where a running instance publishes how to reach it. Clients list this directory to discover instances. */
export interface InstanceRecord {
	id: string;
	pid: number;
	cwd: string;
	startedAt: number;
	protocol: number;
	/** Unix socket path (absent on Windows). */
	socket?: string;
	/** Loopback HTTP endpoint and its bearer token (absent unless HTTP is enabled). */
	http?: { url: string; token: string };
	/** The conversation it runs; a session switch publishes a new record. */
	session?: string;
	/** Its process title, `octocode-agent-<role>-<id>`: what `ps` and `/processes` call it. */
	name?: string;
}

/** The instance records: `<Octocode home>/api` (OCTOCODE_HOME moves it with everything else). */
export const apiDir = (env: NodeJS.ProcessEnv = process.env): string => globalPaths(env).api;

export const instancesDir = (dir: string): string => path.join(dir, "instances");
const recordFile = (dir: string, id: string): string => path.join(instancesDir(dir), `${id}.json`);

export const newInstanceId = (): string => `oc-${crypto.randomBytes(3).toString("hex")}`;
export const newToken = (): string => crypto.randomBytes(32).toString("base64url");

/** Create the directory tree owner-only. Sockets and tokens live here, so it must not be readable by other users. */
export function ensurePrivateDir(dir: string): void {
	fs.mkdirSync(instancesDir(dir), { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") {
		fs.chmodSync(dir, 0o700);
		fs.chmodSync(instancesDir(dir), 0o700);
	}
}

/**
 * Replace the instance's record atomically: a reader sees the old record or the new one. Not flushed to disk: a record
 * describes a running process, which a crash ends, and readers skip a record that does not parse or whose pid is gone.
 */
export function writeRecord(dir: string, record: InstanceRecord): void {
	ensurePrivateDir(dir);
	atomicWriteFileSync(recordFile(dir, record.id), JSON.stringify(record, null, 2), { mode: 0o600, durability: "none" });
	if (record.pid === process.pid && !removedAtExit.has(record.id))
		removedAtExit.set(record.id, removeAtExit(dir, record));
}

export function removeRecord(dir: string, id: string): void {
	removedAtExit.get(id)?.();
	removedAtExit.delete(id);
	fs.rmSync(recordFile(dir, id), { force: true });
}

/** Unregisters the exit release of each record this process wrote for itself. */
const removedAtExit = new Map<string, () => void>();

/**
 * A process that exits without stopping its API (a crash, `process.exit` past the shutdown) removes its record and
 * socket anyway; only SIGKILL leaves them, for the next start's sweep (`listInstances`, `sweepSocketFolders`).
 */
function removeAtExit(dir: string, record: InstanceRecord): () => void {
	return processLifetime.acquire("API record and socket", {
		atExit: () => {
			fs.rmSync(recordFile(dir, record.id), { force: true });
			if (record.socket) removeSocket(record.socket);
		},
	});
}

/** A live record and the name of the file it was read from (`<id>.json` for a record its instance wrote). */
export interface InstanceEntry {
	file: string;
	record: InstanceRecord;
}

/** Whether `entry` is in its instance's own file: Octocode writes no other, so any other is another process's. */
export const inOwnFile = (entry: InstanceEntry): boolean => entry.file === `${entry.record.id}.json`;

/** Removes the file `entry` was read from, and nothing else: a copy in another file goes without the instance's own. */
export function removeEntry(dir: string, entry: InstanceEntry): void {
	fs.rmSync(path.join(instancesDir(dir), entry.file), { force: true });
}

/** Live records with their files, oldest first. By default, records of dead processes are swept with their socket files; completion disables pruning. */
export function listInstanceEntries(dir: string, prune = true): InstanceEntry[] {
	let names: string[];
	try {
		names = fs.readdirSync(instancesDir(dir));
	} catch {
		return [];
	}
	const found: InstanceEntry[] = [];
	for (const name of names.filter((entry) => entry.endsWith(".json"))) {
		const file = path.join(instancesDir(dir), name);
		try {
			const record = JSON.parse(fs.readFileSync(file, "utf8")) as InstanceRecord;
			if (typeof record.id !== "string" || typeof record.pid !== "number") continue;
			if (processAlive(record.pid)) found.push({ file: name, record });
			else if (prune) {
				fs.rmSync(file, { force: true });
				if (record.socket) removeSocket(record.socket);
			}
		} catch {
			// A record being written or corrupt: skip it.
		}
	}
	return found.sort((a, b) => a.record.startedAt - b.record.startedAt);
}

/** Live instances, oldest first (`listInstanceEntries` without the files). */
export function listInstances(dir: string, prune = true): InstanceRecord[] {
	return listInstanceEntries(dir, prune).map((entry) => entry.record);
}

/** When a record was last added, replaced or removed: the instances directory's mtime, undefined when it is missing. */
export function instancesStamp(dir: string): number | undefined {
	try {
		return fs.statSync(instancesDir(dir)).mtimeMs;
	} catch {
		return undefined;
	}
}

/** When the instance `id`'s own file was last written: an overwrite in place leaves the folder's mtime as it was. */
export function recordStamp(dir: string, id: string): number | undefined {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
	try {
		return fs.statSync(recordFile(dir, id)).mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * The live record of the instance `id`, read only from its own file (`<id>.json`): a record elsewhere in the directory
 * that repeats the id is not the instance's. Undefined when the file is missing, unreadable, names another id, or its
 * process is gone.
 */
export function readInstance(dir: string, id: string): InstanceRecord | undefined {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
	try {
		const record = JSON.parse(fs.readFileSync(recordFile(dir, id), "utf8")) as InstanceRecord;
		return record.id === id && typeof record.pid === "number" && processAlive(record.pid) ? record : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The instances `selector` names: an instance id, or else what the process is known by elsewhere: its process name
 * (`octocode-agent-main-c0ea9f3e`), the id `/processes` shows (`c0ea9f3e`), its session id or its pid. Two processes can run
 * one saved session, so all but the instance id can name several.
 */
export function matchInstances(instances: readonly InstanceRecord[], selector: string): InstanceRecord[] {
	const exact = instances.filter((entry) => entry.id === selector);
	if (exact.length) return exact;
	return instances.filter(
		(entry) =>
			entry.name === selector ||
			entry.name?.endsWith(`-${selector}`) ||
			entry.session === selector ||
			String(entry.pid) === selector,
	);
}

/** One instance in an error or a list: everything a caller could name it by. */
export function describeInstance(entry: InstanceRecord): string {
	return `${entry.id} (${[entry.name, `pid ${entry.pid}`, entry.cwd].filter(Boolean).join(", ")})`;
}

const noInstance = (selector: string, running: readonly InstanceRecord[]): string =>
	[
		`No running instance matches "${selector}".`,
		running.length ? `Running: ${running.map(describeInstance).join("; ")}.` : "No instance is running.",
		"A session whose API is off (the sessionApi setting or /api off) comes back with /api on.",
	].join(" ");

/** The one instance `selector` names; a miss or an ambiguous name is an error that lists what would work. */
export function selectInstance(instances: readonly InstanceRecord[], selector: string): InstanceRecord {
	const found = matchInstances(instances, selector);
	if (found.length === 0) throw new Error(noInstance(selector, instances));
	if (found.length > 1)
		throw new Error(
			`Several instances match "${selector}"; use an instance id: ${found.map(describeInstance).join("; ")}.`,
		);
	return found[0];
}

/**
 * A fallback socket's private folder in the temp directory: `octocode-<uid>-<owner pid>-XXXXXX`, made by `mkdtemp`. */
const SOCKET_DIR = /^octocode-(\d+)-(\d+)-[A-Za-z0-9]{6}$/;
/** The one file such a folder holds: `newInstanceId`'s socket. */
const SOCKET_FILE = /^oc-[0-9a-f]{6}\.sock$/;

/** The temp directories a fallback folder can be in: `TMPDIR`, then `/tmp`. */
const socketRoots = (env: NodeJS.ProcessEnv): Set<string> => new Set([env.TMPDIR ?? "/tmp", "/tmp"]);

/**
 * Unix socket paths are limited to ~104 bytes on macOS, so a deep OCTOCODE_HOME would fail to bind. The socket sits
 * next to the record when that fits and otherwise in a folder `mkdtemp` makes in the temp directory (mode 0700, and
 * its name is unguessable): a fixed name there could be taken by another local user before this process binds it. The
 * name carries this process's pid, for `sweepSocketFolders`.
 */
export function socketPath(dir: string, id: string, env: NodeJS.ProcessEnv = process.env): string {
	const preferred = path.join(dir, `${id}.sock`);
	if (Buffer.byteLength(preferred) <= 100) return preferred;
	const prefix = `octocode-${process.getuid?.() ?? 0}-${process.pid}-`;
	for (const root of socketRoots(env)) {
		const base = fs.realpathSync(root);
		if (Buffer.byteLength(path.join(base, `${prefix}XXXXXX`, `${id}.sock`)) > 100) continue;
		const folder = fs.mkdtempSync(path.join(base, prefix));
		return path.join(folder, `${id}.sock`);
	}
	throw new Error("Cannot create a Unix socket path within the 100-byte limit");
}

/** Removes a socket file, and the private temp folder `socketPath` made for it. */
export function removeSocket(file: string): void {
	fs.rmSync(file, { force: true });
	const folder = path.dirname(file);
	if (SOCKET_DIR.test(path.basename(folder))) fs.rmSync(folder, { recursive: true, force: true });
}

/** Whether nothing listens on this socket: only a refused connection says so, any other failure says nothing. */
const refusesConnection = (file: string): Promise<boolean> =>
	new Promise((resolve) => {
		const probe = net.connect(file);
		probe.unref();
		probe.once("connect", () => {
			probe.destroy();
			resolve(false);
		});
		probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "ECONNREFUSED"));
	});

/**
 * Whether `folder` was left by a session that is gone, and removes it if so. It must be this user's owner-only folder
 * holding nothing but one API socket, and neither a live owner pid nor a listener may answer for it: the pid covers a
 * session between its bind and its listen or too busy to accept, and the connection a session in another pid namespace
 * sharing this temp directory. An empty folder (a kill between `mkdtemp` and the bind, or between the unlink and the
 * removal) is proved by its pid alone, so one owned by pid 1 stays. Pid 1 is always alive, so as an
 * owner it proves nothing (a container's main process) and counts as none.
 */
async function removeDeadSocketFolder(folder: string, named: string | undefined): Promise<boolean> {
	const ownerPid = named === "1" ? undefined : named;
	if (ownerPid !== undefined && processAlive(Number(ownerPid))) return false;
	const stat = fs.lstatSync(folder);
	if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) return false;
	const entries = fs.readdirSync(folder);
	if (entries.length === 0 && ownerPid === undefined) return false;
	if (entries.length > 1 || (entries.length === 1 && !SOCKET_FILE.test(entries[0]))) return false;
	if (entries.length === 1) {
		const socket = path.join(folder, entries[0]);
		if (!fs.lstatSync(socket).isSocket() || !(await refusesConnection(socket))) return false;
		fs.rmSync(socket, { force: true });
	}
	fs.rmdirSync(folder);
	return true;
}

/**
 * Removes the fallback folders of sessions that are gone. `listInstances` sweeps through a record, so it never reaches
 * a folder whose home was deleted or is not started again. Runs in the background of a session's start: it never fails
 * the start, and a folder it cannot prove dead stays. Returns how many went.
 */
export async function sweepSocketFolders(
	env: NodeJS.ProcessEnv = process.env,
	roots: Iterable<string> = socketRoots(env),
): Promise<number> {
	if (process.platform === "win32") return 0;
	let removed = 0;
	for (const root of roots) {
		let base: string;
		let names: string[];
		try {
			// Off the event loop: a temp directory can hold thousands of entries (about 17 ms for 11k on macOS), and the
			// start that calls this would otherwise wait for them before its MCP servers launch.
			base = await fs.promises.realpath(root);
			names = await fs.promises.readdir(base);
		} catch {
			continue;
		}
		for (const name of names) {
			const folder = SOCKET_DIR.exec(name);
			if (!folder || Number(folder[1]) !== process.getuid?.()) continue;
			if (await removeDeadSocketFolder(path.join(base, name), folder[2]).catch(() => false)) removed++;
		}
	}
	return removed;
}
