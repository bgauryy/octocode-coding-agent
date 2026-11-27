import type { WatchdogLimits, ChildProgress } from "../events.ts";
import type { AgentProfile } from "../profiles.ts";
import type { RelayHost } from "../relay.ts";
import type { Identity } from "./env.ts";

/** One child run, as `runChild` and `runSubagent` take it. */
export interface ChildRun {
	/** The first prompt; its request budget may prefix it. */
	task: string;
	/** The child's CLI arguments after the Octocode entry. */
	args: string[];
	cwd: string;
	profile?: AgentProfile;
	identity: Identity;
	/** Stops the run: the child is aborted, its input closed and its process tree stopped. */
	signal?: AbortSignal;
	/** Display only: a throw here never ends the run. */
	onProgress: (progress: ChildProgress) => void;
	/** The child's pid, once spawned; a throw here stops the run. */
	onSpawn?: (pid: number) => void;
	/** The watchdog's limits (`WATCHDOG` by default). */
	limits?: WatchdogLimits;
	/** The parent session the child's dialogs, approvals, budget and progress reach. */
	host?: RelayHost;
	/** Resolves when the task may be sent (`stagger.ts`); the child boots at once either way. */
	ready?: () => Promise<void>;
	/** The child's process exited or failed to start (each start of a retried one): `stagger.ts` stops holding its siblings for it. */
	exited?: () => void;
	/**
	 * The run settled for good: its report is known while the child still exits and is cleaned up. A hint for batching
	 * reports (`ReportQueue`); a throw here is ignored.
	 */
	settled?: () => void;
	/** Takes how to ask whether the child still works toward its answer: running, not stalled, not waiting for a person, not stopped. */
	working?: (probe: () => boolean) => void;
	/** That answer may have turned false (an exit, a stall, a question to the user, a stop); a throw here is ignored. */
	workingChanged?: () => void;
}

/**
 * Where a run is:
 * - `booting`: spawned, the task held back until `ready`;
 * - `prompted`: the task was sent and the child works on it (an interrupt or the outcome ask may start another run);
 * - `leaving`: the child settled and its input is closed; with a report it has `SETTLED_EXIT_MS` to exit;
 * - `concluded`: the run settled once; every timer is cleared and nothing else may change it.
 * A stop of the process tree is not a phase: an abort, a late leave or a group the child left behind can start it in any
 * phase before `concluded`, and the run concludes only after it.
 */
type RunPhaseName = "booting" | "prompted" | "leaving" | "concluded";

/** The run's phase and the timers and stop that belong to it, in one place. */
export class RunPhase {
	#name: RunPhaseName = "booting";
	/** The one stop of the child's process tree; started at most once. */
	#stopping: Promise<void> | undefined;
	/** The child settled with its report, was told to leave, and was stopped when it did not exit in time. */
	#leftLate = false;
	#exitDeadline: NodeJS.Timeout | undefined;
	#followUp: NodeJS.Timeout | undefined;
	#exitGrace: NodeJS.Timeout | undefined;
	/** Other cleanup the run waits for before it concludes (the shell groups a crashed child left). */
	readonly #cleanups: Promise<unknown>[] = [];

	get concluded(): boolean {
		return this.#name === "concluded";
	}

	get leftLate(): boolean {
		return this.#leftLate;
	}

	/** What the run must wait for before it concludes: the stop and any cleanup; undefined when there is none. */
	pending(): Promise<unknown> | undefined {
		const all = [this.#stopping, ...this.#cleanups].filter((each) => each !== undefined);
		return all.length ? Promise.all(all) : undefined;
	}

	/** The task was sent. */
	prompted(): void {
		if (this.#name === "booting") this.#name = "prompted";
	}

	/** Starts the one stop of the process tree, unless one already runs; its failure is ignored. */
	stop(start: () => Promise<void>): void {
		if (this.concluded) return;
		this.#stopping ??= start().catch(() => undefined);
	}

	/** The stop `stop` started, until it ends; undefined when none did. */
	get stopping(): Promise<void> | undefined {
		return this.#stopping;
	}

	/** Cleanup the run waits for before it concludes; its failure is ignored. */
	cleanup(work: Promise<unknown>): void {
		if (!this.concluded) this.#cleanups.push(work.catch(() => undefined));
	}

	/**
	 * The child's input is closed. With `deadlineMs`, a child still running when it passes left late: `onLate` stops it.
	 * The deadline is armed once.
	 */
	leave(deadlineMs: number | undefined, onLate: () => void): void {
		if (this.concluded) return;
		this.#name = "leaving";
		if (deadlineMs === undefined || this.#exitDeadline) return;
		this.#exitDeadline = setTimeout(() => {
			if (this.concluded) return;
			this.#leftLate = true;
			onLate();
		}, deadlineMs);
		this.#exitDeadline.unref();
	}

	/** Waits `ms` after an aborted settle nobody here asked for, then runs `then` (replacing any earlier wait). */
	followUp(ms: number, then: () => void): void {
		clearTimeout(this.#followUp);
		this.#followUp = setTimeout(then, ms);
	}

	cancelFollowUp(): void {
		clearTimeout(this.#followUp);
	}

	/** The child exited; the run settles after `ms` if its pipes stay open. */
	exited(ms: number, settle: () => void): void {
		if (this.concluded) return;
		this.#exitGrace = setTimeout(settle, ms);
	}

	/** Moves to `concluded` and clears every timer; false when the run had already concluded. */
	conclude(): boolean {
		if (this.concluded) return false;
		this.#name = "concluded";
		clearTimeout(this.#exitGrace);
		clearTimeout(this.#exitDeadline);
		clearTimeout(this.#followUp);
		return true;
	}
}
