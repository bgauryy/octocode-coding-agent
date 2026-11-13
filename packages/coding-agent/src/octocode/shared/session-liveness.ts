import { type Db, sessions } from "../../../../db/src/api.ts";
import { readSessionHeaderForDiscovery } from "../../core/session-manager/storage.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { liveProcess, sameProcess } from "./process.ts";

/**
 * The one liveness test for an Octocode session (backlog claims, `/resume`, the sweep): the pid recorded in its
 * `sessions` row, when that process still runs. The team's `agents` table cannot stand in for it: a session has a row
 * there only after it joins the team, and most never do. `started` is the process start time recorded with the pid
 * (`pid_started`): a crashed session whose pid the system gave to another process is not running. A row without one
 * (recorded where start times are unknown) is judged by the pid alone.
 */
export function runningPid(pid: number | null | undefined, started?: string | null): number | undefined {
	return pid != null && sameProcess(pid, started) ? pid : undefined;
}

/** `runningPid` of session `id`; `timer` uses the shared process cache without synchronous `ps`. */
export function sessionRunningPid(db: Db, id: string, timer = false): number | undefined {
	const row = sessions.pidOf(db, id);
	if (timer) return row?.pid != null && liveProcess(row.pid, row.pid_started) ? row.pid : undefined;
	return runningPid(row?.pid, row?.pid_started);
}

/**
 * Live pid recorded for a session file, or undefined when the file/index is unavailable or no live process owns it.
 * Reads only the header: the process that has the session open may be appending to the transcript.
 */
export function sessionFileRunningPid(sessionPath: string): number | undefined {
	try {
		const header = readSessionHeaderForDiscovery(sessionPath);
		return header ? sessionRunningPid(sharedAgentDb().db, header.id) : undefined;
	} catch {
		// Resuming does not require the optional index: without it, retain the ordinary session-open path.
		return undefined;
	}
}
