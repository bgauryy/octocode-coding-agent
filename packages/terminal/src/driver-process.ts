import { type ChildProcess, spawn } from "node:child_process";
import { sharedClock } from "@octocodeai/octocode-common/clock";
import { readDriverLines } from "./driver-lines.ts";
import type { DriverMatch } from "./types.ts";

/**
 * A long-lived shell that answers completion requests over a line protocol. Node writes `id<TAB>text`; the driver prints
 * `id<TAB>value<TAB>description<TAB>flags` per match and `id<TAB><RS>` when it is done. `<RS>READY` (ASCII record
 * separator) says it finished starting; any other output is ignored, so a chatty startup file cannot break the protocol.
 */
const RS = "\x1e";
const MAX_PENDING_REQUESTS = 32;
const MAX_MATCHES = 10_000;
const MAX_RESULT_CHARS = 1024 * 1024;

export interface DriverLaunch {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
}

interface Pending {
	matches: DriverMatch[];
	characters: number;
	discarded: boolean;
	resolve(matches: DriverMatch[] | undefined): void;
	startedAt: number;
}

export interface DriverTimings {
	/** How long startup may take before the shell is given up for this session (a startup file that waits or execs). */
	startMs: number;
	/** How long the oldest unanswered request may wait before the shell is restarted (a completion that hangs). */
	stallMs: number;
}

export const DEFAULT_TIMINGS: DriverTimings = { startMs: 15_000, stallMs: 8_000 };

/** One running driver. `request` resolves undefined when the shell is gone, the request was aborted or it stalled. */
export class DriverProcess {
	private child: ChildProcess | undefined;
	private readonly pending = new Map<string, Pending>();
	private nextId = 0;
	private readonly ready: Promise<boolean>;
	private resolveReady: (ready: boolean) => void = () => {};
	private startTimer: ReturnType<typeof setTimeout> | undefined;
	private stopReading: (() => void) | undefined;
	private retainedMatches = 0;
	private retainedCharacters = 0;
	/** Stops the stall watch's clock subscription while requests wait. */
	private stopStallWatch: (() => void) | undefined;
	private closed = false;
	private readonly timings: DriverTimings;
	private readonly onExit: () => void;

	constructor(launch: DriverLaunch, timings: DriverTimings = DEFAULT_TIMINGS, onExit: () => void = () => {}) {
		this.timings = timings;
		this.onExit = onExit;
		this.ready = new Promise<boolean>((resolveReady) => {
			this.resolveReady = resolveReady;
			let started = false;
			const startTimer = setTimeout(() => {
				if (!started) {
					resolveReady(false);
					this.close();
				}
			}, timings.startMs);
			startTimer.unref?.();
			this.startTimer = startTimer;
			let child: ChildProcess;
			try {
				child = spawn(launch.command, launch.args, {
					cwd: launch.cwd,
					env: launch.env,
					stdio: ["pipe", "pipe", "ignore"],
					detached: process.platform !== "win32",
				});
			} catch {
				clearTimeout(startTimer);
				resolveReady(false);
				this.closed = true;
				return;
			}
			this.child = child;
			child.on("error", () => {
				clearTimeout(startTimer);
				resolveReady(false);
				this.close();
			});
			child.on("exit", () => {
				clearTimeout(startTimer);
				resolveReady(false);
				this.close();
			});
			child.stdin?.on("error", () => this.close());
			this.stopReading = readDriverLines(
				child.stdout!,
				(line) => {
					if (!started) {
						if (line === `${RS}READY`) {
							started = true;
							clearTimeout(startTimer);
							resolveReady(true);
						}
						return;
					}
					this.receive(line);
				},
				() => this.close(),
			);
		});
	}

	/** True once the driver started; false when it failed to start or exited. */
	whenReady(): Promise<boolean> {
		return this.ready.then((ready) => ready && !this.closed);
	}

	get isClosed(): boolean {
		return this.closed;
	}

	/** Completions of `text`, or undefined when the shell is not usable or `signal` aborted first. */
	async request(text: string, signal: AbortSignal): Promise<DriverMatch[] | undefined> {
		if (/[\x00-\x1f\x7f]/.test(text) || signal.aborted || this.closed) return undefined;
		if (!(await this.waitForStartup(signal)) || this.closed || signal.aborted) return undefined;
		if (this.pending.size >= MAX_PENDING_REQUESTS) {
			this.close();
			return undefined;
		}
		const id = String(++this.nextId);
		return new Promise<DriverMatch[] | undefined>((resolve) => {
			const onAbort = () => {
				// Keep its deadline until the shell answers, but release already received matches immediately.
				const entry = this.pending.get(id);
				if (!entry) return;
				this.releaseMatches(entry);
				entry.discarded = true;
				entry.resolve(undefined);
				entry.resolve = () => {};
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, {
				matches: [],
				characters: 0,
				discarded: false,
				startedAt: Date.now(),
				resolve: (matches) => {
					signal.removeEventListener("abort", onAbort);
					resolve(matches);
				},
			});
			this.watchStalls();
			this.child?.stdin?.write(`${id}\t${text}\n`);
		});
	}

	private waitForStartup(signal: AbortSignal): Promise<boolean> {
		return new Promise((resolve) => {
			const finish = (ready: boolean) => {
				signal.removeEventListener("abort", onAbort);
				resolve(ready);
			};
			const onAbort = () => finish(false);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			else void this.ready.then(finish);
		});
	}

	private releaseMatches(entry: Pending): void {
		this.retainedMatches -= entry.matches.length;
		this.retainedCharacters -= entry.characters;
		entry.matches = [];
		entry.characters = 0;
	}

	private receive(line: string): void {
		const tab = line.indexOf("\t");
		if (tab < 0) return;
		const entry = this.pending.get(line.slice(0, tab));
		if (!entry) return;
		const rest = line.slice(tab + 1);
		if (rest === RS) {
			this.pending.delete(line.slice(0, tab));
			entry.resolve(entry.matches);
			this.releaseMatches(entry);
			return;
		}
		if (entry.discarded) return;
		const [value = "", description = "", flags = ""] = rest.split("\t");
		if (!value) return;
		if (this.retainedMatches >= MAX_MATCHES || this.retainedCharacters + rest.length > MAX_RESULT_CHARS) {
			this.close();
			return;
		}
		entry.matches.push({ value, description, flags });
		entry.characters += rest.length;
		this.retainedCharacters += rest.length;
		this.retainedMatches++;
	}

	private watchStalls(): void {
		if (this.stopStallWatch) return;
		this.stopStallWatch = sharedClock.subscribe(
			() => {
				const oldest = this.pending.values().next().value?.startedAt;
				if (this.pending.size === 0) {
					this.stopStallWatch?.();
					this.stopStallWatch = undefined;
				} else if (oldest !== undefined && Date.now() - oldest > this.timings.stallMs) this.close();
			},
			{ everyMs: Math.max(50, Math.floor(this.timings.stallMs / 4)) },
		);
	}

	/** Stops the shell and answers every waiting request with undefined. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.startTimer);
		this.startTimer = undefined;
		this.resolveReady(false);
		this.stopReading?.();
		this.stopReading = undefined;
		this.stopStallWatch?.();
		this.stopStallWatch = undefined;
		for (const entry of this.pending.values()) entry.resolve(undefined);
		this.pending.clear();
		this.retainedMatches = 0;
		this.retainedCharacters = 0;
		const child = this.child;
		child?.stdin?.destroy();
		child?.stdout?.destroy();
		if (child && child.exitCode === null && child.signalCode === null) {
			try {
				// The driver leads its own process group: the inner shell and any completion it started go too.
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGHUP");
				else child.kill();
			} catch {
				child.kill();
			}
			// Interactive shells and completion functions can trap HUP/TERM; they must not keep the host alive.
			const force = setTimeout(() => {
				if (child.exitCode !== null || child.signalCode !== null) return;
				try {
					if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
					else child.kill("SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}, 200);
			force.unref?.();
			child.once("exit", () => clearTimeout(force));
		}
		this.onExit();
	}
}
