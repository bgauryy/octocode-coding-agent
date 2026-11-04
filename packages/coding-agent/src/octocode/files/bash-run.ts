import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { constants as osConstants } from "node:os";
import type { BashOperations } from "../../core/tools/index.ts";
import { clampTimeoutSeconds, resolveShell, spawnShell } from "../../utils/shell.ts";
import { groupAlive, groupMembers, KILL_GRACE_MS, killTree } from "../shared/process.ts";
import { signalTree } from "../../utils/process-tree.ts";
import { firstLine } from "../shared/util.ts";
import type { BashJob } from "./bash-jobs/types.ts";
import { nonInteractiveEnv, type ShellSettings } from "./bash-jobs/shell.ts";

/**
 * How a foreground command runs: Octocode's local shell execution (core/tools/bash `createLocalShellOperations`, handed to
 * Octocode's bash as its `operations`), with two changes. Esc and the deadline stop the command's tree with SIGTERM and only
 * then SIGKILL (`killTree`), where Octocode sends SIGKILL at once and nothing gets to clean up (temp files, lock files, child
 * servers). And the caller learns the command's process group, so it can name processes the command left running
 * (`server &`): Octocode stops the group only on a timeout or abort, so they keep running after it returns.
 */

/** After the shell exits, how long its pipes may stay quiet before the output counts as complete (Octocode's own value). */
const EXIT_STDIO_GRACE_MS = 100;
/** Output of a running foreground command kept in memory, so a command moved to the background can start its log with it. */
const KEPT_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Processes listed by name in the "left running" note; the rest are counted. */
const LISTED_STRAYS = 5;
/** After a stop, how long the waiter keeps reading: until SIGKILL has reached the group, and its last output has arrived. */
const STOP_DRAIN_MS = KILL_GRACE_MS + EXIT_STDIO_GRACE_MS;
/**
 * How long an aborted call waits for this tool: the command's SIGTERM cleanup and last output (`STOP_DRAIN_MS`), then
 * the time to close the spill file, so the result keeps what the command printed and says how it ended.
 */
export const BASH_ABORT_GRACE_MS = STOP_DRAIN_MS + 400;

/** Process groups of foreground commands running now: Octocode kills its own at exit, so these die with Octocode too. */
const running = new Set<number>();
const killRunning = (): void => {
	for (const pid of running) signalTree(pid, "SIGKILL");
};

function track(pid: number): void {
	if (running.size === 0) process.on("exit", killRunning);
	running.add(pid);
}

function untrack(pid: number): void {
	running.delete(pid);
	if (running.size === 0) process.off("exit", killRunning);
}

/** The last `KEPT_OUTPUT_BYTES` of what a command printed. */
class KeptOutput {
	private chunks: Buffer[] = [];
	private bytes = 0;
	private dropped = 0;

	push(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.bytes += chunk.length;
		while (this.bytes > KEPT_OUTPUT_BYTES && this.chunks.length > 1) {
			const first = this.chunks.shift()!;
			this.bytes -= first.length;
			this.dropped += first.length;
		}
	}

	snapshot(): Buffer {
		const note = this.dropped > 0 ? [Buffer.from(`[${this.dropped} bytes of earlier output not kept]\n`)] : [];
		return Buffer.concat([...note, ...this.chunks]);
	}
}

/** Why a running foreground command moves: its deadline passed, or a message from the user is waiting for the agent. */
export type HandoffReason = "deadline" | "message";

/**
 * Hands a foreground command that is still running to the background job manager: what it printed so far, and when it
 * started. Returns the job, which now owns the process and its pipes.
 */
type Handoff = (child: ChildProcess, output: Buffer, startedAt: number, reason: HandoffReason) => BashJob;

/** Moves a command to the background once `pending()` says a message that asks for the agent (the user's) is waiting. */
export interface PendingWatch {
	pending: () => boolean;
	/** The command must have run this long first, so a quick one still returns its own result. */
	afterMs?: number;
	pollMs?: number;
}

const DEFAULT_WATCH_AFTER_MS = 1000;
const DEFAULT_WATCH_POLL_MS = 250;

/**
 * Resolves with the shell's exit code once it exited and its pipes ended, or fell quiet for `EXIT_STDIO_GRACE_MS`: a
 * process it left behind may hold them open forever. Output still arriving keeps it reading (Octocode's waitForChildProcess).
 * `detach` stops watching, leaves the process and its pipes alone, and resolves with undefined. `stopped` says the command
 * was told to stop: output then keeps it reading for `STOP_DRAIN_MS` after the shell exits and no longer, since a writer
 * that left the group is out of reach of the stop and would otherwise hold the call past its deadline.
 */
function waitForExit(child: ChildProcess): {
	done: Promise<number | null | undefined>;
	detach: () => void;
	stopped: () => void;
} {
	let detach = (): void => undefined;
	let stopped = (): void => undefined;
	const done = new Promise<number | null | undefined>((resolve, reject) => {
		let settled = false;
		let exited = false;
		let code: number | null = null;
		let idle: NodeJS.Timeout | undefined;
		let drain: NodeJS.Timeout | undefined;
		let stopRequested = false;
		const open = new Set([child.stdout, child.stderr].filter((pipe) => pipe !== null));
		const unlisten: Array<() => void> = [];
		const listen = (target: NodeJS.EventEmitter, event: string, handler: Parameters<NodeJS.EventEmitter["on"]>[1]) => {
			target.on(event, handler);
			unlisten.push(() => target.off(event, handler));
		};
		detach = () => {
			if (settled) return;
			settled = true;
			clearTimers();
			for (const off of unlisten) off();
			resolve(undefined);
		};
		const clearTimers = () => {
			if (idle) clearTimeout(idle);
			if (drain) clearTimeout(drain);
		};
		const finalize = () => {
			if (settled) return;
			settled = true;
			clearTimers();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};
		const arm = () => {
			if (idle) clearTimeout(idle);
			idle = setTimeout(finalize, EXIT_STDIO_GRACE_MS);
		};
		const armDrain = () => {
			drain ??= setTimeout(finalize, STOP_DRAIN_MS);
		};
		stopped = () => {
			stopRequested = true;
			if (exited && !settled) armDrain();
		};
		for (const pipe of open) {
			listen(pipe, "end", () => {
				open.delete(pipe);
				if (exited && open.size === 0) finalize();
			});
			listen(pipe, "data", () => {
				if (exited && !settled) arm();
			});
		}
		listen(child, "error", (error) => {
			if (settled) return;
			settled = true;
			clearTimers();
			reject(error);
		});
		listen(child, "exit", (exitCode) => {
			exited = true;
			code = exitCode;
			if (open.size === 0) finalize();
			else {
				arm();
				if (stopRequested) armDrain();
			}
		});
		listen(child, "close", (exitCode) => {
			code ??= exitCode;
			finalize();
		});
	});
	return { done, detach: () => detach(), stopped: () => stopped() };
}

/**
 * The foreground shell operations for one call. `onGroup` receives the command's process group leader when the
 * command returned on its own. At the deadline a command still running goes to `handoff` when there is one (it
 * keeps running; exec then throws the usual `timeout:` error, and the caller knows the job from its own handoff); with
 * none, `stopAtDeadline`, or when the handoff fails, or after an abort, the whole group is stopped. With `watch`, a
 * command that has run a moment also moves as soon as a user message is waiting, so the agent can answer it.
 */
export function foregroundOperations(
	settings: ShellSettings,
	onGroup: (pid: number) => void,
	handoff?: Handoff,
	onExit?: (signal: NodeJS.Signals | null) => void,
	{ watch, stopAtDeadline = false }: { watch?: PendingWatch; stopAtDeadline?: boolean } = {},
): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			if (signal?.aborted) throw new Error("aborted");
			// Node timers stop at MAX_TIMER_SECONDS (clamped here): a longer timeout is that long, and a non-positive one is no timeout.
			timeout = clampTimeoutSeconds(timeout);
			if (!fs.existsSync(cwd))
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			const child = await spawnShell(resolveShell(settings), command, {
				cwd,
				env: nonInteractiveEnv(env ?? process.env),
			});
			const pid = child.pid;
			if (pid) track(pid);
			let timedOut = false;
			// Seconds the command ran when a waiting message moved it (a deadline reports its own length).
			let movedAfter: number | undefined;
			const startedAt = Date.now();
			const kept = handoff ? new KeptOutput() : undefined;
			const stop = () => {
				killTree(pid);
				waiter.stopped();
			};
			const read = (chunk: Buffer) => {
				kept?.push(chunk);
				onData(chunk);
			};
			const waiter = waitForExit(child);
			// Only a shell still running can move; one that exited is waiting for its pipes to end.
			const moveToBackground = (reason: HandoffReason): boolean => {
				if (!handoff || !kept || child.exitCode !== null || child.signalCode !== null) return false;
				child.stdout?.off("data", read);
				child.stderr?.off("data", read);
				try {
					handoff(child, kept.snapshot(), startedAt, reason);
				} catch {
					child.stdout?.on("data", read);
					child.stderr?.on("data", read);
					return false;
				}
				waiter.detach();
				return true;
			};
			const timer =
				timeout === undefined
					? undefined
					: setTimeout(() => {
							timedOut = true;
							if (stopAtDeadline || !moveToBackground("deadline")) stop();
						}, timeout * 1000);
			const watcher =
				watch && handoff
					? setInterval(() => {
							if (timedOut || Date.now() - startedAt < (watch.afterMs ?? DEFAULT_WATCH_AFTER_MS)) return;
							try {
								if (!watch.pending()) return;
							} catch {
								return;
							}
							timedOut = true;
							movedAfter = Math.round((Date.now() - startedAt) / 1000);
							if (moveToBackground("message")) clearInterval(watcher);
							else timedOut = false;
						}, watch.pollMs ?? DEFAULT_WATCH_POLL_MS)
					: undefined;
			child.stdout?.on("data", read);
			child.stderr?.on("data", read);
			// An abort during `prepareTree` fired before this listener existed: stop the command now, not when it ends.
			if (signal?.aborted) stop();
			else signal?.addEventListener("abort", stop, { once: true });
			try {
				const code = await waiter.done;
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${movedAfter ?? timeout}`);
				onExit?.(child.signalCode);
				if (pid) onGroup(pid);
				// A signal-killed shell has no exit code: the shell convention keeps it from reading as success.
				return { exitCode: code ?? (child.signalCode ? 128 + (osConstants.signals[child.signalCode] ?? 0) : 1) };
			} finally {
				if (pid) untrack(pid);
				if (timer) clearTimeout(timer);
				if (watcher) clearInterval(watcher);
				signal?.removeEventListener("abort", stop);
			}
		},
	};
}

/**
 * The per-call fact for a command that returned while processes it started (`server &`) still run in its group:
 * which ones, and how to stop them. Undefined when the group is gone (always on Windows, which has no groups).
 */
export function strayNote(pid: number): string | undefined {
	if (process.platform === "win32" || !groupAlive(pid)) return undefined;
	const members = groupMembers(pid);
	if (members.length === 0) return undefined;
	const listed = members
		.slice(0, LISTED_STRAYS)
		.map((member) => `${member.pid} ${firstLine(member.command).slice(0, 80)}`);
	const more = members.length > LISTED_STRAYS ? `; +${members.length - LISTED_STRAYS} more` : "";
	return `Still running after the command returned (not stopped): ${listed.join("; ")}${more}. Stop: kill -- -${pid}. Use background: true to have such a process's exit reported.`;
}
