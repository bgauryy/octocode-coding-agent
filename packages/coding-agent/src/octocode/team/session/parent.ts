import { onSecond } from "../../shared/clock.ts";
import { liveProcess, parentGone, sameProcess, terminateSelf } from "../../shared/process.ts";
import { PARENT_PID_ENV } from "../store/env.ts";
import type { ProcessIdentity } from "../store/members.ts";

/**
 * Whether the process named by `OCTOCODE_PARENT_PID` (`<pid> <start time>`, the start time when known) is gone. A
 * direct parent is judged by the pid and reparenting; through a launcher, a recorded start time tells a later process
 * that reused the pid from the parent. `compareStart`: `now` compares it at once (one `ps` on this thread), `known` only
 * as far as the shared process table already shows (`liveProcess`, for a caller that polls), false not at all.
 */
export function parentProcessGone(value: string, compareStart: "now" | "known" | false = "now"): boolean {
	const [pid = "", ...started] = value.trim().split(" ");
	const parentPid = Number(pid);
	if (!Number.isInteger(parentPid) || parentPid <= 0) return false;
	if (parentGone(parentPid)) return true;
	if (!compareStart || process.ppid === parentPid || started.length === 0) return false;
	const live = compareStart === "now" ? sameProcess : liveProcess;
	return !live(parentPid, started.join(" "));
}

/** The process `OCTOCODE_PARENT_PID` names (`<pid> <start time>`), or undefined when `env` names none. */
export function namedParent(env: NodeJS.ProcessEnv): ProcessIdentity | undefined {
	const [pid = "", ...started] = (env[PARENT_PID_ENV] ?? "").trim().split(" ");
	const parentPid = Number(pid);
	if (!Number.isInteger(parentPid) || parentPid <= 0) return undefined;
	return { pid: parentPid, ...(started.length > 0 ? { started: started.join(" ") } : {}) };
}

/** The parent is gone: where a signal ends the process outright (Windows) nothing runs after it, so the row and reservations go now, not when a peer's sweep finds the pid dead. */
export function endWithParent(leave: (reason: "parent-gone") => void): void {
	try {
		leave("parent-gone");
	} catch {
		/* locked database: the sweep reaps the row */
	}
	terminateSelf();
}

/**
 * Checks once a second, on the shared clock, whether the parent named by `PARENT_PID_ENV` is gone, and calls `gone` on
 * each check that finds it so. Returns what stops the check, or undefined when `env` names no parent.
 */
export function watchParentProcess(env: NodeJS.ProcessEnv, gone: () => void): (() => void) | undefined {
	const parent = env[PARENT_PID_ENV];
	if (!parent) return undefined;
	// Never a `ps` on this thread: a reused pid is noticed once the shared process table, read off it, shows it.
	return onSecond(() => {
		if (!parentProcessGone(parent, "known")) return;
		gone();
	});
}
