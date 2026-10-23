/** A background job and how it ended. */

export interface BashJob {
	id: string;
	command: string;
	/** Where it runs; its log path is shown relative to it. */
	cwd: string;
	pid: number;
	log: string;
	startedAt: number;
	/** Seconds after which the job is stopped; unset: it runs until it exits, is stopped, or the session ends. */
	timeout?: number;
	/** Why the extension stopped it, when it did. */
	stopped?: "timeout" | "user" | "session end" | "reload" | "run end";
	/** Its process group is gone; only its last output may still be draining before `done` resolves. */
	exited?: boolean;
	done: Promise<JobExit>;
}

export interface JobExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	seconds: number;
	/** Set when the job's log stopped recording: its size then and why. */
	logStopped?: { bytes: number; error: string };
	/** Set when the log rotated: how many times (the second rotation and later drop the oldest output). */
	logRotations?: number;
}
