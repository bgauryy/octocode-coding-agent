import { url as inspectorUrl } from "node:inspector";
import { Worker } from "node:worker_threads";

/** How long a terminal mode switch may hold the main thread on the way out before the process is ended. */
export const TERMINAL_RESTORE_STALL_MS = 5_000;

/** The threads print nothing, and must not be piped into the terminal's streams, which would add listeners there. */
const OWN_OUTPUT = { stdout: true, stderr: true } as const;

/** Runs on its own thread, so its timer still fires while the main thread is blocked inside a system call. */
const GUARD = `
const { workerData } = require("node:worker_threads");
setTimeout(() => process.kill(process.pid, "SIGKILL"), workerData.ms);
`;

/**
 * Runs `run` and ends the process if it holds the main thread for longer than `ms`.
 *
 * For calls made while exiting that can block without limit. Leaving raw mode waits for the terminal to read pending
 * output (libuv sets the mode with `TCSADRAIN`), so a terminal that stopped reading froze the process there forever,
 * with the session still registered and its children still running. No timer on the main thread can end such a wait.
 * A kill skips exit hooks: the terminal that is not reading could not have shown their output either.
 *
 * Without worker threads `run` is called unguarded.
 */
export function endIfStalled<T>(run: () => T, ms: number = TERMINAL_RESTORE_STALL_MS): T {
	let guard: Worker | undefined;
	try {
		guard = new Worker(GUARD, { eval: true, execArgv: [], workerData: { ms }, ...OWN_OUTPUT });
		guard.unref();
	} catch {
		// No thread could start: the call runs as it did before the guard existed.
	}
	try {
		return run();
	} finally {
		void guard?.terminate();
	}
}

/** How long the main thread of a session may stay blocked before the session is ended. */
export const MAIN_THREAD_STALL_MS = 120_000;

/** How often the main thread reports that it runs, and the watch checks. */
const BEAT_MS = 1_000;

/**
 * The watch thread. The main thread counts up in `beat[0]`; a count that stands still for `limitMs` means it is
 * blocked. A tick of this thread that comes late itself means the whole process was stopped (Ctrl+Z) or the machine
 * slept: that time is not counted. Before ending the process it appends one line to `notePath`, the only trace a
 * blocked process can leave.
 */
const WATCH = `
const { workerData } = require("node:worker_threads");
const { appendFileSync } = require("node:fs");
const beat = new Int32Array(workerData.shared);
let seen = Atomics.load(beat, 0);
let since = Date.now();
let ticked = since;
setInterval(() => {
	const now = Date.now();
	if (now - ticked > workerData.beatMs * 5) since = now;
	ticked = now;
	const count = Atomics.load(beat, 0);
	if (count !== seen) {
		seen = count;
		since = now;
		return;
	}
	if (now - since < workerData.limitMs) return;
	if (workerData.notePath) {
		try {
			appendFileSync(workerData.notePath, JSON.stringify({
				time: new Date(now).toISOString(),
				pid: process.pid,
				title: process.title,
				cwd: workerData.cwd,
				blockedMs: now - since,
				action: "ended the process: its main thread was blocked",
			}) + "\\n", { mode: 0o600 });
		} catch {}
	}
	process.kill(process.pid, "SIGKILL");
}, workerData.beatMs);
`;

/**
 * Ends the process when its main thread stays blocked for `limitMs`, and returns what stops the watch.
 *
 * A session whose main thread is stuck inside a system call (a terminal that stopped reading, a lock that is never
 * released) cannot time itself out, answer a signal or stop its subagents: it stays registered as working while its
 * children run on. Ended, it is seen as gone: its children stop (`team/session/parent.ts`) and its registration is
 * reaped. Nothing is watched under a debugger, where a paused main thread is intended.
 */
export function watchMainThread(options: { limitMs?: number; notePath?: string } = {}): () => void {
	if (inspectorUrl()) return () => undefined;
	let watch: Worker;
	const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
	try {
		watch = new Worker(WATCH, {
			eval: true,
			execArgv: [],
			...OWN_OUTPUT,
			workerData: {
				shared,
				beatMs: BEAT_MS,
				limitMs: options.limitMs ?? MAIN_THREAD_STALL_MS,
				notePath: options.notePath,
				cwd: process.cwd(),
			},
		});
	} catch {
		return () => undefined;
	}
	watch.unref();
	const beat = new Int32Array(shared);
	const timer = setInterval(() => Atomics.add(beat, 0, 1), BEAT_MS);
	timer.unref();
	return () => {
		clearInterval(timer);
		void watch.terminate();
	};
}
