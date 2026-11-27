import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processAlive } from "../../shared/process.ts";
import { processLifetime } from "@octocodeai/octocode-common/process-lifetime";

/**
 * Bytes a Unix socket path may hold: macOS `sun_path` is 104 including the terminating NUL, Linux 108. The library
 * names its proxy socket `srt-mux-<pid>-<n>.sock` in the system temporary folder; a longer path makes `listen` fail
 * with EINVAL. The name is budgeted at its worst case: a 7-digit pid and a 3-character counter.
 */
const SOCKET_PATH_LIMIT = 103;
const SOCKET_NAME_BUDGET = "srt-mux-9999999-zzz.sock".length;

/** Where the private folder goes: short whatever `TMPDIR` says; `mkdtemp` makes the folder 0700, owned by this account. */
const SHORT_ROOT = "/tmp";
const PREFIX = "octocode-sb-";
/** The library's proxy socket: its name holds the pid of the process that bound it. */
const SOCKET_NAME = /^srt-mux-(\d+)-.*\.sock$/;

/**
 * `<pid>:<folder>`: the folder a process made, exported for the processes it starts (subagents). A child that a
 * crashing parent kills cannot remove its own folder, so a direct child makes its folder inside its parent's, which
 * the parent removes on exit. Anyone else (a session started from a command) ignores it.
 */
export const SOCKET_ROOT_ENV = "OCTOCODE_SANDBOX_SOCKET_ROOT";

/** The pids whose proxy sockets `dir` and the folders nested in it hold. */
function socketOwners(dir: string, depth = 0): number[] {
	const pids: number[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const pid = SOCKET_NAME.exec(entry.name)?.[1];
		if (pid !== undefined) pids.push(Number(pid));
		else if (entry.isDirectory() && entry.name.startsWith(PREFIX) && depth < 3)
			pids.push(...socketOwners(path.join(dir, entry.name), depth + 1));
	}
	return pids;
}

/**
 * Removes this account's socket folders in `root` whose every socket owner is gone: those of a process killed by
 * SIGKILL, or a child its crashing parent killed before it could nest. A folder with no socket yet is being started.
 */
export function reapOrphanedSocketDirs(root: string = SHORT_ROOT): string[] {
	const removed: string[] = [];
	for (const name of fs.readdirSync(root)) {
		if (!name.startsWith(PREFIX)) continue;
		const dir = path.join(root, name);
		const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
		if (!stat?.isDirectory() || stat.uid !== process.getuid?.()) continue;
		const owners = socketOwners(dir);
		if (owners.length === 0 || !owners.every((pid) => !processAlive(pid))) continue;
		fs.rmSync(dir, { recursive: true, force: true });
		removed.push(dir);
	}
	return removed;
}

/** The parent's folder, when this process is its direct child and a folder made inside it still fits a socket path. */
function parentFolder(env: NodeJS.ProcessEnv): string | undefined {
	const match = /^(\d+):(\/.+)$/.exec(env[SOCKET_ROOT_ENV] ?? "");
	if (!match || Number(match[1]) !== process.ppid) return undefined;
	const dir = match[2];
	if (tempDirTooLongForSocket(path.join(dir, `${PREFIX}XXXXXX`))) return undefined;
	return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? dir : undefined;
}

function makeFolder(): string {
	const parent = parentFolder(process.env);
	if (parent) {
		try {
			return fs.mkdtempSync(path.join(parent, PREFIX));
		} catch (error) {
			// The parent removed its folder meanwhile, or it is not ours to write: use the shared root.
			if (!["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
	}
	reapOrphanedSocketDirs();
	return fs.mkdtempSync(path.join(SHORT_ROOT, PREFIX));
}

/** True when the library's proxy socket would not fit in the system temporary folder. */
export function tempDirTooLongForSocket(tempDir: string = os.tmpdir()): boolean {
	return Buffer.byteLength(path.join(tempDir, "x".repeat(SOCKET_NAME_BUDGET))) > SOCKET_PATH_LIMIT;
}

/**
 * Runs `start`, the library's initialization, which binds its proxy socket in the system temporary folder. When that
 * folder is too long for a socket path, the socket goes in a short private folder instead: `TMPDIR` names it for the
 * duration of `start` only, then returns to its value. Nothing else changes: commands keep the host's temporary
 * folder, and the sandbox opens no new path (the library, not the command, uses the socket). The folder lives as long
 * as the library's proxy, so it is removed when the process exits, or at once when `start` fails. Its path is exported
 * (`SOCKET_ROOT_ENV`) for the processes this one starts; on a crash or SIGKILL, the next start reaps what is left.
 */
export async function withSocketFriendlyTempDir<T>(start: () => Promise<T>): Promise<T> {
	if (!tempDirTooLongForSocket()) return start();
	const dir = makeFolder();
	const atExit = processLifetime.acquirePath("sandbox socket folder", dir);
	const hostTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = dir;
	try {
		const started = await start();
		process.env[SOCKET_ROOT_ENV] = `${process.pid}:${dir}`;
		return started;
	} catch (error) {
		atExit();
		fs.rmSync(dir, { recursive: true, force: true });
		throw error;
	} finally {
		if (hostTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = hostTmpdir;
	}
}
