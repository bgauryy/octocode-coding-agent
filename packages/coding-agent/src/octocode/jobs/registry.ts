import { AsyncJobs } from "./async-jobs.ts";

/**
 * One `AsyncJobs` per session, found from the session's manager: the session feature attaches it at `session_start`, and
 * any tool finds the same one from its call context. Held weakly: it goes with the session.
 */
const owners = new WeakMap<object, AsyncJobs>();

export function asyncJobsFor(session: object): AsyncJobs {
	let jobs = owners.get(session);
	if (!jobs) {
		jobs = new AsyncJobs();
		owners.set(session, jobs);
	}
	return jobs;
}

/** Foreground budget every tool call gets before its work continues as a job. */
export const TOOL_FOREGROUND_MS = 15_000;
