import { spawn } from "node:child_process";
import { psFieldsSync } from "@octocodeai/octocode-common/process-start";
import { validPid } from "./process-id.ts";
import { windowsTree } from "./windows/winhelper.ts";
import { system32Executable } from "./windows/winpath.ts";

/**
 * Process-tree control shared by every shell executor (core's local bash, Octocode's foreground and background bash,
 * subagents, hooks, RPC): spawn the root with `detached: process.platform !== "win32"` (see `spawnShell` in
 * shell.ts), call `prepareTree` before and `adoptTree` after it, and end it with `signalTree`.
 */

/** `taskkill /T /F` on `pid`: walks the tree below a live root, and fails (exit 128) once the root has exited. Never throws. */
export function taskkillTree(pid: number): void {
	try {
		spawn(system32Executable("taskkill.exe"), ["/pid", String(pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		}).on("error", () => undefined);
	} catch {
		// taskkill is missing; nothing more to do.
	}
}

/**
 * Ends the Windows tree rooted at `pid`: its job when the helper holds one (every member goes, also the descendants of
 * a root that exited), else, or when the job could not be killed, `taskkill`. Resolves once the job is ended.
 */
export async function killWindowsTree(pid: number): Promise<void> {
	if (windowsTree.owns(pid) && (await windowsTree.kill(pid))) return;
	taskkillTree(pid);
}

/**
 * Starts what tracking a process tree needs, before the process spawns: on Windows, the helper that owns its job (its
 * startup takes a while, and a child started before the assignment is not in the job). A no-op elsewhere.
 */
export async function prepareTree(): Promise<void> {
	if (process.platform === "win32") await windowsTree.start();
}

/**
 * Right after spawning the root of a tree: on Windows, puts it in a job, so `signalTree`, `stopTree` and `killTree`
 * reach assigned members and the job ends with Octocode. Assignment is asynchronous and best effort. A no-op elsewhere:
 * POSIX callers own a process group (`detached: true`), which does not retain descendants that leave that group.
 */
export function adoptTree(pid: number | undefined): void {
	if (process.platform === "win32") void windowsTree.assign(pid);
}

// Polls once a second; ends when the group is empty or its owner is gone. The owner is its pid with its start time
// ($3): a reused pid is another process. A group left behind by a dead owner gets SIGTERM, then SIGKILL one second later.
const PARENT_WATCH = [
	'while kill -0 -- "-$2" 2>/dev/null && [ "$(ps -o lstart= -p "$1" 2>/dev/null)" = "$3" ]; do sleep 1; done',
	'if kill -0 -- "-$2" 2>/dev/null; then',
	'kill -s TERM -- "-$2" 2>/dev/null; sleep 1; kill -s KILL -- "-$2" 2>/dev/null',
	"fi",
].join("\n");

const WATCH_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC0" };
let ownStart: string | undefined;

/** This process's `ps` start time, read once; the watcher compares it with the live owner's. */
function ownerStart(): string | undefined {
	ownStart ??= psFieldsSync(process.pid, "lstart=", WATCH_ENV)?.replace(/\n$/, "");
	return ownStart;
}

/**
 * For a root that leads its own process group (spawned `detached`) and whose group must not outlive this process even
 * when this process is killed without cleanup: starts a detached `sh` that ends the group once this process is gone,
 * also when the root exited and only background children remain. It does not end a group while this process lives, and
 * exits within a second of the group's last member. The root keeps its own pipes; the watcher holds none. Returns the watcher's
 * pid (undefined on Windows, where the job ends with Octocode, or when it could not start).
 */
export function reapWithParent(pid: number | undefined): number | undefined {
	if (process.platform === "win32" || !validPid(pid)) return undefined;
	const started = ownerStart();
	if (started === undefined) return undefined;
	try {
		const watcher = spawn("/bin/sh", ["-c", PARENT_WATCH, "sh", String(process.pid), String(pid), started], {
			stdio: "ignore",
			detached: true,
			env: WATCH_ENV,
		});
		watcher.on("error", () => undefined);
		watcher.unref();
		return watcher.pid;
	} catch {
		return undefined;
	}
}

/**
 * Sends `signal` to the process tree rooted at `pid`: its process group on POSIX (spawn it with `detached: true` so it
 * leads one; otherwise only the process itself is signalled), and on Windows, which has no signals, its job (see
 * `adoptTree`) or else `taskkill /T /F`. Never throws.
 */
export function signalTree(pid: number | undefined, signal: NodeJS.Signals): void {
	if (!validPid(pid)) return;
	if (process.platform === "win32") {
		void killWindowsTree(pid);
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Already gone.
		}
	}
}
