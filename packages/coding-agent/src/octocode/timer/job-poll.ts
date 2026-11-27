import path from "node:path";
import { recordFile } from "../shared/job-records.ts";

/**
 * A background job whose end already notifies this session: a bash job it started or joined (with its process, log and
 * command), or a `task-N` job of another tool (an id only).
 */
export type LiveJob = BashLiveJob | { id: string };

interface BashLiveJob {
	id: string;
	pid: number;
	log: string;
	command: string;
}

const isBash = (job: LiveJob): job is BashLiveJob => "pid" in job;

/** The shortest `pgrep` pattern taken as naming a job's command: shorter ones match too much to say anything. */
const MIN_PATTERN = 4;

/** Words of one simple command, with quotes dropped: `pgrep -f 'yarn run x'` is [`pgrep`, `-f`, `yarn run x`]. */
function words(segment: string): string[] {
	return [...segment.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

/** `kill -0 <pid>` (or the job's process group, `-<pid>`) signals nothing but asks whether the job still runs. */
function killsJob(args: string[], job: BashLiveJob): boolean {
	const at = args.indexOf("kill");
	if (at < 0 || args[at + 1] !== "-0") return false;
	return args.slice(at + 2).some((arg) => arg === String(job.pid) || arg === `-${job.pid}`);
}

/** `test -e|-f <path>` (or `[ … ]`) of the job's log or its owner record. */
function testsJobFile(args: string[], job: BashLiveJob, cwd: string): boolean {
	const at = args.findIndex((arg) => arg === "test" || arg === "[" || arg === "[[");
	if (at < 0) return false;
	const files = new Set([job.log, recordFile(job.log)].map((file) => path.resolve(cwd, file)));
	for (let i = at + 1; i < args.length - 1; i++)
		if ((args[i] === "-e" || args[i] === "-f") && files.has(path.resolve(cwd, args[i + 1] ?? ""))) return true;
	return false;
}

/** `pgrep [-f] <pattern>` where the pattern is part of the job's command. */
function pgrepsJob(args: string[], job: BashLiveJob): boolean {
	const at = args.indexOf("pgrep");
	if (at < 0) return false;
	const pattern = args.slice(at + 1).findLast((arg) => !arg.startsWith("-"));
	return pattern !== undefined && pattern.length >= MIN_PATTERN && job.command.includes(pattern);
}

/** A command that names a `task-N` job by its id polls it. */
const namesJob = (args: string[], job: LiveJob): boolean => args.some((arg) => arg.split(/[^\w-]+/).includes(job.id));

/**
 * The job among `jobs` that `command` polls for its end. A bash job by `kill -0 <pid>`, `test -e|-f <log>` or
 * `pgrep <part of its command>`; a task job by naming its id. Anything else is a request of its own and passes.
 */
export function polledJob(command: string, jobs: readonly LiveJob[], cwd: string): LiveJob | undefined {
	const segments = command.split(/&&|\|\||[;&|\n(){}]/).map(words);
	return jobs.find((job) =>
		segments.some((args) =>
			isBash(job) ? killsJob(args, job) || testsJobFile(args, job, cwd) || pgrepsJob(args, job) : namesJob(args, job),
		),
	);
}
