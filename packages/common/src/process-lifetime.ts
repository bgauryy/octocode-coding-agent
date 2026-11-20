import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The one owner of what a process acquires and must release on every exit path: process groups it started, paths it
 * created, sockets it bound. Each acquire registers its release and gets back the function that unregisters it, called
 * when the owner releases the resource itself. A graceful end (a quit, a shutdown signal) awaits `shutdown`, which runs
 * the graceful releases in reverse order of acquisition within a deadline. Every exit (`process.exit`, a crash, the end
 * of the event loop) then runs the synchronous last-resort releases, also in reverse order, from a single `exit`
 * listener of the default instance. SIGKILL runs nothing: owners that must survive it keep owner records
 * (`process-group-records.ts`) for the next start to reap. Host-free, so every package may register here.
 */

export interface Release {
	/** Graceful: awaited by `shutdown`, bounded by what is left of its deadline. */
	graceful?: () => Promise<void>;
	/** Last resort, at exit: kill a group, remove a path. Synchronous, since nothing asynchronous runs after `exit`. */
	atExit?: () => void;
}

export interface ShutdownResult {
	/** Names whose graceful release had not settled by the deadline. */
	timedOut: string[];
	failed: Array<{ name: string; error: unknown }>;
}

export interface ProcessLifetime {
	acquire(name: string, release: Release): () => void;
	/** `signal` to process group `pid` at exit (POSIX; Windows has no groups, so nothing is registered there). */
	acquireGroup(name: string, pid: number, signal?: NodeJS.Signals): () => void;
	/** Removes `target`, which this process created (pass what `mkdtemp` returned), at exit. Throws on a protected path. */
	acquirePath(name: string, target: string): () => void;
	/** Adds a root `acquirePath` must never remove, nor any folder holding it (the agent folder, a workspace). */
	protectPath(root: string): void;
	shutdown(deadlineMs: number): Promise<ShutdownResult>;
	/** The last-resort releases, newest first; each runs once, and a failing one never stops the rest. */
	runAtExit(): void;
	/** Names of what is registered now, oldest first. */
	names(): string[];
}

interface Entry extends Release {
	name: string;
}

function report(name: string, error: unknown): void {
	// Written at once: nothing queued (a warning, a log line) is printed once the process is exiting.
	process.stderr.write(
		`Octocode could not release ${name} at exit: ${error instanceof Error ? error.message : String(error)}\n`,
	);
}

function contains(folder: string, target: string): boolean {
	const relative = path.relative(folder, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function createProcessLifetime(options: { onFirstAcquire?: () => void } = {}): ProcessLifetime {
	const entries = new Set<Entry>();
	const protectedRoots = new Set<string>();
	let started = false;

	const acquire = (name: string, release: Release): (() => void) => {
		const entry: Entry = { name, ...release };
		entries.add(entry);
		if (!started) {
			started = true;
			options.onFirstAcquire?.();
		}
		return () => {
			entries.delete(entry);
		};
	};

	const refusal = (target: string): string | undefined => {
		if (!path.isAbsolute(target)) return "it is not absolute";
		const resolved = path.resolve(target);
		const roots = [path.parse(resolved).root, os.homedir(), os.tmpdir(), ...protectedRoots];
		const root = roots.find((candidate) => contains(resolved, path.resolve(candidate)));
		return root === undefined ? undefined : `it is or holds ${root}`;
	};

	return {
		acquire,
		acquireGroup(name, pid, signal = "SIGKILL") {
			if (process.platform === "win32") return () => undefined;
			if (!Number.isInteger(pid) || pid <= 1) throw new Error(`${name}: ${pid} is not a process group id`);
			return acquire(name, {
				atExit: () => {
					try {
						process.kill(-pid, signal);
					} catch (error) {
						// ESRCH: the group already ended. Never fall back to the positive pid, which may be reused.
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
					}
				},
			});
		},
		acquirePath(name, target) {
			const why = refusal(target);
			if (why) throw new Error(`${name}: refusing to remove ${target} at exit: ${why}`);
			const resolved = path.resolve(target);
			return acquire(name, { atExit: () => fs.rmSync(resolved, { recursive: true, force: true }) });
		},
		protectPath(root) {
			if (!path.isAbsolute(root)) throw new Error(`A protected root must be absolute: ${root}`);
			protectedRoots.add(path.resolve(root));
		},
		async shutdown(deadlineMs) {
			const deadline = Date.now() + deadlineMs;
			const result: ShutdownResult = { timedOut: [], failed: [] };
			for (const entry of [...entries].reverse()) {
				if (!entry.graceful || !entries.has(entry)) continue;
				const left = deadline - Date.now();
				if (left <= 0) {
					result.timedOut.push(entry.name);
					continue;
				}
				let timer: NodeJS.Timeout | undefined;
				const expired = new Promise<"timeout">((resolve) => {
					timer = setTimeout(() => resolve("timeout"), left);
				});
				try {
					if ((await Promise.race([entry.graceful(), expired])) === "timeout") result.timedOut.push(entry.name);
				} catch (error) {
					result.failed.push({ name: entry.name, error });
				} finally {
					clearTimeout(timer);
				}
			}
			return result;
		},
		runAtExit() {
			for (const entry of [...entries].reverse()) {
				entries.delete(entry);
				try {
					entry.atExit?.();
				} catch (error) {
					report(entry.name, error);
				}
			}
		},
		names: () => [...entries].map((entry) => entry.name),
	};
}

/** This process's lifetime: its `exit` listener is installed with the first acquire, once. */
export const processLifetime: ProcessLifetime = createProcessLifetime({
	onFirstAcquire: () => process.on("exit", () => processLifetime.runAtExit()),
});
