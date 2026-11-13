/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import os from "node:os";
import { waitForChildProcess } from "../../../common/src/child-process.ts";
import { leadsProcessGroup, trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.ts";

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/** How long a process told to stop gets before it is forced. */
const FORCE_KILL_MS = 5000;

/** A process a signal ended has no exit code: the shell's `128 + n`, so it never reads as success. */
function signalExitCode(signal: NodeJS.Signals | null): number {
	const number = signal ? os.constants.signals[signal] : undefined;
	return number === undefined ? 1 : 128 + number;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 *
 * On POSIX the command leads a session of its own (`detached`, so `setsid`): it is not in the terminal's foreground
 * group, has no controlling terminal to open as `/dev/tty`, and Ctrl+Z or a terminal signal does not reach it. A stop
 * signals its whole group, so a tree it started ends with it; Octocode exiting kills a group still running.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const group = leadsProcessGroup();
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			detached: group,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const pid = proc.pid;
		if (group && pid) trackDetachedChildPid(pid);

		let stdout = "";
		let stderr = "";
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;
		// `proc.killed` only says a signal was sent, so the escalation asks whether the process really ended.
		let exited = false;
		let forceKill: NodeJS.Timeout | undefined;
		proc.once("exit", () => {
			exited = true;
			// A process group can outlive its root; keep its escalation and exit tracking.
			if (!group) clearTimeout(forceKill);
		});
		/** The command's group (its descendants too); only the command itself once its group is gone or on Windows. */
		const signal = (name: NodeJS.Signals) => {
			if (group && pid) {
				try {
					process.kill(-pid, name);
					return;
				} catch {
					// The group is gone: only a root that has not exited is left to signal.
				}
			}
			if (!exited) proc.kill(name);
		};
		// Stops the wait once the command was told to stop: a writer that left its group outlives the kill.
		const stopped = new AbortController();

		const killProcess = () => {
			if (!killed) {
				killed = true;
				stopped.abort();
				signal("SIGTERM");
				// Force kill after 5 seconds if SIGTERM doesn't work
				if (exited && !group) return;
				forceKill = setTimeout(() => {
					if (group || !exited) signal("SIGKILL");
					forceKill = undefined;
					if (group && pid) untrackDetachedChildPid(pid);
				}, FORCE_KILL_MS);
				forceKill.unref();
			}
		};

		// Handle abort signal
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		const settled = () => {
			if (group && pid && !forceKill) untrackDetachedChildPid(pid);
		};
		waitForChildProcess(proc, stopped.signal)
			.finally(settled)
			.then((code) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: code ?? signalExitCode(proc.signalCode), killed });
			})
			.catch((error: unknown) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				// The process never ran or could not be waited for: why is the only output there is.
				const why = error instanceof Error ? error.message : String(error);
				resolve({ stdout, stderr: stderr ? `${stderr}\n${why}` : why, code: 1, killed });
			});
	});
}
