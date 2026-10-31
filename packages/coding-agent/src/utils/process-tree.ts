import { spawn } from "node:child_process";
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
 * reach its whole tree and the tree ends with Octocode. Asynchronous and best effort; a no-op elsewhere (the process group
 * is the tree there: spawn with `detached: true`).
 */
export function adoptTree(pid: number | undefined): void {
	if (process.platform === "win32") void windowsTree.assign(pid);
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
