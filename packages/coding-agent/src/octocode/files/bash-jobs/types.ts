/** Evidence about one explicitly requested check, not an assertion that the workspace is correct. */
export interface VerificationReceipt {
	command: string;
	cwd: string;
	startedAt: number;
	completedAt?: number;
	state: "running" | "finished" | "failed" | "stopped";
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	elapsedSeconds?: number;
	output: {
		complete: boolean;
		log?: string;
		logAvailable?: boolean;
		archiveAvailable?: boolean;
		tailIncomplete?: boolean;
		rotations?: number;
	};
	sessionId: string;
	mutationEpoch: string;
	revisionAtLaunch: number;
	revisionAtCompletion?: number;
	stale: boolean;
}

/** A background job and how it ended. */

export interface BashJob {
	id: string;
	command: string;
	/** Why it runs: the bash call's `reason`. A job has no backlog item; its command says what it does, this says why. */
	reason?: string;
	/** The backlog item (`B12`) the job serves: while it runs, the item is not idle. */
	item?: string;
	/** Where it runs; its log path is shown relative to it. */
	cwd: string;
	pid: number;
	log: string;
	startedAt: number;
	verification?: VerificationReceipt;
	/** Seconds after which the job is stopped; unset: it runs until it exits, is stopped, or the session ends. */
	timeout?: number;
	/** Why the extension stopped it, when it did. */
	stopped?: "timeout" | "user" | "session end" | "reload" | "run end";
	/** Its process group is gone; only its last output may still be draining before `done` resolves. */
	exited?: boolean;
	done: Promise<JobExit>;
}

/** What the note a /reload leaves names of each job it stopped. */
export type ReloadedJob = Pick<BashJob, "id" | "command" | "reason" | "log">;

export interface JobExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	seconds: number;
	/** Set when the job's log stopped recording: its size then and why. */
	logStopped?: { bytes: number; error: string };
	/** Set when the log rotated: how many times (the second rotation and later drop the oldest output). */
	logRotations?: number;
}
