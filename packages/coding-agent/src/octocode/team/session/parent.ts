import { onSecond } from "../../shared/clock.ts";
import { parentGone, sameProcess, terminateSelf } from "../../shared/process.ts";
import { PARENT_PID_ENV } from "../store/env.ts";
import type { ProcessIdentity } from "../store/members.ts";

/** Every this many parent checks (one a second, on the shared clock) the start time is compared too: a reused pid is noticed within that many seconds, and the event loop is not stalled by a `ps` every second. */
const PARENT_START_EVERY = 15;

/**
 * Whether the process named by `OCTOCODE_PARENT_PID` (`<pid> <start time>`, the start time when known) is gone. A
 * direct parent is judged by the pid and reparenting; through a launcher, a recorded start time tells a later process
 * that reused the pid from the parent.
 */
export function parentProcessGone(value: string, compareStart = true): boolean {
	const [pid = "", ...started] = value.trim().split(" ");
	const parentPid = Number(pid);
	if (!Number.isInteger(parentPid) || parentPid <= 0) return false;
	if (parentGone(parentPid)) return true;
	// The start time costs a synchronous `ps`, so a caller that polls compares it only now and then (`compareStart`).
	return compareStart && process.ppid !== parentPid && started.length > 0 && !sameProcess(parentPid, started.join(" "));
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
	let checks = 0;
	return onSecond(() => {
		if (!parentProcessGone(parent, checks++ % PARENT_START_EVERY === 0)) return;
		gone();
	});
}
