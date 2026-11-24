import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { bashSessionEnv } from "../../core/tools/bash.ts";
import {
	clampTimeoutSeconds,
	leadsProcessGroup,
	resolveBashShell,
	spawnShell,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import { atomicWriteFileSync } from "@octocodeai/octocode-common/atomic-file";
import { OWNER_JOB_ENV } from "@octocodeai/octocode-common/env";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { formatDuration } from "../shared/format.ts";
import { shortPath } from "../../utils/display-path.ts";
import { privateDir, sessionOutputDir } from "../shared/home.ts";
import { groupAlive, killTree, processStartTime, reapWithParent, stopTree } from "../shared/process.ts";
import { RotatingLog } from "../shared/rotating-log.ts";
import { shellGroupRegistration } from "../shared/shell-groups.ts";
import { firstLine, wholeSeconds } from "../shared/util.ts";
import { sessionBashDirs } from "./bash-jobs/records.ts";
import { type JobRecord, recordFile } from "../shared/job-records.ts";
import { nonInteractiveEnv, type ShellSettings, shellScript } from "./bash-jobs/shell.ts";
import type { BashJob, JobExit, ReloadedJob, VerificationReceipt } from "./bash-jobs/types.ts";
import { jobWhyLine } from "./bash-jobs/message.ts";
import { PRIVATE_FILE_MODE } from "@octocodeai/octocode-common/file-mode";

/**
 * Background shell jobs for the `bash` tool (bash.ts): each runs in its own process group, with the user's Octocode shell,
 * command prefix and Octocode's environment. Its output comes back through pipes and Octocode writes it to a size-capped,
 * rotating log in the session's `bash/` folder. Next to each log an owner record names the job and the Octocode that started
 * it, so a later Octocode can stop a job whose Octocode died without ending it (`reapOrphanJobs`).
 */

/** A job log past this size moves to `<log>.1` (replacing the one before) and starts over, so a chatty server cannot fill the disk. */
const MAX_JOB_LOG_BYTES = 16 * 1024 * 1024;
/** After the job's process group is gone, how long its pipes may take to deliver the last output, in ms. */
const DRAIN_MS = 1_000;
/** How often a job whose shell exited checks whether children it left in its group are still running, in ms. */
const GROUP_POLL_MS = 250;

/** A running job of another session this session joined; `done` resolves once its end was reported here. */
export type JoinedJob = Pick<BashJob, "command" | "pid" | "log" | "startedAt"> & { id: string; done: Promise<unknown> };

/** What a run-end hold waits on: an own job or a joined one. */
export type HeldJob = JoinedJob;

/** Background shell jobs of one session: each runs in its own process group with output going to a log file. */
export class BashJobs {
	readonly jobs = new Map<string, BashJob>();
	/** Running jobs of other sessions this session joined, whose end it hears of; keyed by session and job. */
	readonly joined = new Map<string, JoinedJob>();
	private next = 0;

	private readonly dir?: string;
	constructor(dir?: string) {
		this.dir = dir;
	}

	/** Where logs go: the given directory, else the current session's `bash/` folder. */
	logDir(): string {
		return this.dir ?? sessionOutputDir("bash");
	}

	async start(
		command: string,
		cwd: string,
		asked: number | undefined,
		onExit: (job: BashJob, exit: JobExit) => void,
		{
			env = bashSessionEnv(undefined),
			shell: settings = {},
			maxLogBytes = MAX_JOB_LOG_BYTES,
			verification,
			reason,
			item,
			unsandboxed = false,
		}: {
			env?: NodeJS.ProcessEnv;
			shell?: ShellSettings;
			maxLogBytes?: number;
			verification?: VerificationReceipt;
			reason?: string;
			item?: string;
			/** The user allowed this command outside the command sandbox (`shell.unsandboxed`). */
			unsandboxed?: boolean;
		} = {},
	): Promise<BashJob> {
		if (!fs.existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
		// Node fires a timer longer than 2^31-1 ms at once, which would stop the job as soon as it started.
		const timeout = clampTimeoutSeconds(asked);
		const shell = resolveBashShell(settings);
		// Named before the spawn: the command's environment carries it (`OCTOCODE_JOB_ID`).
		const id = this.reserveId();
		const child = await spawnShell(shell, shellScript(command, settings), {
			cwd,
			registerGroup: shellGroupRegistration(),
			env: nonInteractiveEnv({ ...env, [OWNER_JOB_ENV]: id }),
			unsandboxed,
		});
		if (child.pid === undefined) {
			// Spawning failed (no shell, EAGAIN, EMFILE): the 'error' event that follows names the cause. Nothing ran.
			const cause = await new Promise<unknown>((resolve) => child.once("error", resolve));
			throw new Error(
				`Could not start a background shell (${shell.shell}): ${errorMessage(cause)}. Nothing is running.`,
			);
		}
		return this.register(child, child.pid, command, cwd, onExit, {
			id,
			timeout,
			maxLogBytes,
			verification,
			reason,
			item,
		});
	}

	/** The next job id; ids are never reused within this instance, even by a start that fails. */
	private reserveId(): string {
		return `bash-${++this.next}`;
	}

	/**
	 * Takes over a foreground command that reached its deadline while still running: `output` (what it printed so far)
	 * goes to the new log first, then whatever its pipes deliver. The caller has stopped reading the pipes. With
	 * `timeout` (seconds from now: what is left of the call's own timeout) the job is stopped then; without one it runs
	 * until it exits, is stopped, or the session ends, and a headless run stops it (`settle`) like any untimed job.
	 * `startedAt` is when the command began.
	 */
	adopt(
		child: ChildProcess,
		command: string,
		cwd: string,
		onExit: (job: BashJob, exit: JobExit) => void,
		{
			output,
			startedAt,
			timeout: left,
			maxLogBytes = MAX_JOB_LOG_BYTES,
			verification,
			reason,
			item,
		}: {
			output: Buffer;
			startedAt: number;
			timeout?: number;
			maxLogBytes?: number;
			verification?: VerificationReceipt;
			reason?: string;
			item?: string;
		},
	): BashJob {
		if (child.pid === undefined) throw new Error("The command has no process to move");
		const options = { timeout: clampTimeoutSeconds(left), maxLogBytes, output, startedAt, verification, reason, item };
		return this.register(child, child.pid, command, cwd, onExit, options);
	}

	/** Records and watches a running shell as a job: log, owner record, exit handling. */
	private register(
		child: ChildProcess,
		pid: number,
		command: string,
		cwd: string,
		onExit: (job: BashJob, exit: JobExit) => void,
		{
			id = this.reserveId(),
			timeout,
			maxLogBytes,
			output: earlier,
			startedAt = Date.now(),
			verification,
			reason,
			item,
		}: {
			id?: string;
			timeout?: number;
			maxLogBytes: number;
			output?: Buffer;
			startedAt?: number;
			verification?: VerificationReceipt;
			reason?: string;
			item?: string;
		},
	): BashJob {
		// Job ids restart with each feature instance (a /reload), so the start time keeps an earlier log.
		let log: string;
		let output: RotatingLog;
		try {
			const dir = this.logDir();
			privateDir(dir);
			log = path.join(dir, `${id}-${Date.now()}.log`);
			output = new RotatingLog(log, maxLogBytes);
		} catch (error) {
			// The shell already runs. A storage failure must not leave an unregistered tree or open pipes behind.
			killTree(pid);
			child.once("error", () => undefined);
			for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe?.destroy();
			child.unref();
			throw error;
		}
		if (earlier && earlier.length > 0) output.write(earlier);
		const record = recordFile(log);
		try {
			const owned: JobRecord = {
				id,
				pid,
				started: processStartTime(pid),
				command,
				...(item ? { item } : {}),
				log,
				host: os.hostname(),
				owner: { pid: process.pid, started: processStartTime(process.pid) },
			};
			privateDir(path.dirname(record));
			atomicWriteFileSync(record, JSON.stringify(owned), { mode: PRIVATE_FILE_MODE });
		} catch {
			// Without its record only this Octocode can stop the job.
		}
		// A hard-killed Octocode runs no session_shutdown: the watcher ends the job's group once this process is gone.
		reapWithParent(pid);
		// The job, and its output pipes, must not keep a print run's process alive; session_shutdown stops it.
		child.unref();
		const pipes = [child.stdout, child.stderr].filter((pipe) => pipe !== null) as Socket[];
		const drained = Promise.all(
			pipes.map((pipe) => new Promise<void>((resolve) => pipe.once("close", () => resolve()))),
		);
		for (const pipe of pipes) {
			pipe.on("data", (chunk: Buffer) => output.write(chunk));
			pipe.on("error", () => undefined);
			pipe.unref();
		}
		let timer: NodeJS.Timeout | undefined;
		// The job, for `finish` to mark exited: it exists before any child event can fire.
		const state: { job?: BashJob } = {};
		const done = new Promise<JobExit>((resolve) => {
			let finished = false;
			const finish = (code: number | null, signal: NodeJS.Signals | null) => {
				if (finished) return;
				finished = true;
				if (state.job) state.job.exited = true;
				if (timer) clearTimeout(timer);
				// The pipes close once every writer is gone; a process that left the group may hold them open forever.
				void Promise.race([drained, new Promise((settle) => setTimeout(settle, DRAIN_MS).unref())]).then(() => {
					for (const pipe of pipes) pipe.destroy();
					output.close();
					const seconds = wholeSeconds(Date.now() - startedAt);
					resolve({
						code,
						signal,
						seconds,
						...(output.failure ? { logStopped: output.failure } : {}),
						...(output.rotations > 0 ? { logRotations: output.rotations } : {}),
					});
				});
			};
			child.once("error", (error) => {
				output.write(`\n${errorMessage(error)}\n`);
				finish(null, null);
			});
			// The shell can exit while children it started (`server &`) still run in its group and write to the log: the
			// job lasts until the group is gone, so they stay capped, stoppable and stopped at session end.
			child.once("exit", (code, signal) => {
				const wait = (): void => {
					if (groupAlive(pid)) setTimeout(wait, GROUP_POLL_MS).unref();
					else finish(code, signal);
				};
				wait();
			});
		});
		const job: BashJob = { id, command, cwd, pid, log, startedAt, verification, done };
		if (reason) job.reason = reason;
		if (item) job.item = item;
		if (timeout) job.timeout = timeout;
		state.job = job;
		if (timeout) {
			timer = setTimeout(() => this.stop(id, "timeout"), timeout * 1000);
			timer.unref();
		}
		this.jobs.set(id, job);
		// A crash or `process.exit` that skips the session's shutdown still kills the job's group; a graceful shutdown
		// stops it first (`stopAll`), so a signal spares it.
		const grouped = leadsProcessGroup();
		if (grouped) trackDetachedChildPid(pid, { graceful: true });
		void done.then((exit) => {
			if (grouped) untrackDetachedChildPid(pid);
			this.jobs.delete(id);
			try {
				fs.rmSync(record, { force: true });
			} catch {
				// A later Octocode finds the job gone and removes the record.
			}
			onExit(job, exit);
		});
		return job;
	}

	/** Stops a job's whole process tree; false when no such job runs. A job that already exited keeps its own status. */
	stop(id: string, reason: NonNullable<BashJob["stopped"]>): boolean {
		const job = this.jobs.get(id);
		if (!job) return false;
		if (job.exited) return true;
		job.stopped ??= reason;
		killTree(job.pid);
		return true;
	}

	/** Every job whose end this session waits for: its own running jobs and the running jobs of other sessions it joined. */
	held(): HeldJob[] {
		return [...this.running(), ...this.joined.values()];
	}

	/** Jobs whose process group still runs (an exited job only waits for its last output). */
	running(): BashJob[] {
		return [...this.jobs.values()].filter((job) => !job.exited);
	}

	/** Stops every running job; resolves once each tree that outlived SIGTERM got SIGKILL (Octocode may exit right after). */
	async stopAll(reason: NonNullable<BashJob["stopped"]>): Promise<void> {
		const jobs = this.running();
		for (const job of jobs) job.stopped ??= reason;
		await Promise.all(jobs.map((job) => stopTree(job.pid)));
	}

	/**
	 * Before a headless run ends: jobs without a timeout (a server, a watcher) would never finish, so they are stopped;
	 * resolves once every job has exited (each exit sends its report).
	 */
	settle(): Promise<unknown> {
		for (const job of this.running()) if (!job.timeout) this.stop(job.id, "run end");
		return Promise.all([...this.jobs.values()].map((job) => job.done));
	}

	/** The owner-record folders to check for jobs left by a dead Octocode: the given directory, else every session's. */
	recordDirs(): string[] {
		return this.dir ? [this.dir] : sessionBashDirs();
	}

	/** At a /reload (same process, same session), records the jobs it stops so the next feature instance can name them. */
	noteReload(stopped: readonly BashJob[]): void {
		if (stopped.length === 0) return;
		try {
			atomicWriteFileSync(
				this.reloadNote(),
				JSON.stringify(stopped.map(({ id, command, reason, log }): ReloadedJob => ({ id, command, reason, log }))),
				{ mode: PRIVATE_FILE_MODE },
			);
		} catch {
			// The reports in the conversation still name them.
		}
	}

	/** The jobs the last /reload of this process stopped (read once). */
	takeReloadNote(): ReloadedJob[] {
		const file = this.reloadNote();
		try {
			const jobs = JSON.parse(fs.readFileSync(file, "utf8")) as ReloadedJob[];
			return Array.isArray(jobs) ? jobs : [];
		} catch {
			return [];
		} finally {
			fs.rmSync(file, { force: true });
		}
	}

	private reloadNote(): string {
		return path.join(this.logDir(), `reload-${process.pid}.json`);
	}

	/** One entry per running job, for `/jobs`: what it runs, why, and its log; `links` adds text after the command (`jobLinks`). */
	describe(now = Date.now(), links: ReadonlyMap<string, string> = new Map()): string {
		if (this.jobs.size === 0) return "No background bash jobs are running.";
		return [...this.jobs.values()]
			.map(
				(job) =>
					`${job.id} · ${formatDuration(now - job.startedAt)}${job.timeout ? ` of ${formatDuration(job.timeout * 1000)}` : ""} · pid ${job.pid} · ${firstLine(job.command).slice(0, 80)}${links.get(job.id) ?? ""}\n${jobWhyLine(job, "  ")}  log: ${shortPath(job.log)}`,
			)
			.join("\n");
	}
}
