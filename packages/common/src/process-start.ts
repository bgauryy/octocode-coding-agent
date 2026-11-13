import { execFile } from "node:child_process";

/**
 * When a process started, as `ps -o lstart=` prints it. A pid alone proves nothing once the system reuses it: the pid
 * with its start time names one process. Host-free: the coding agent's process table and the session lock read it here.
 */

/**
 * `ps` in UTC and the C locale: `lstart` is printed in the reader's time zone, so two Octocode processes in different
 * zones would disagree.
 */
export const PS_UTC_ENV = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: "C", TZ: "UTC0" });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LSTART = /^\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/** The fields of an `lstart` text (`Mon Jan  2 15:04:05 2006`): year, month (0-11), day, hours, minutes, seconds. */
export function lstartFields(lstart: string): [number, number, number, number, number, number] | undefined {
	const match = LSTART.exec(lstart.trim().replace(/\s+/g, " "));
	const month = MONTHS.indexOf(match?.[1] ?? "");
	if (!match || month < 0) return undefined;
	return [Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])];
}

/** Seconds since the epoch of an `lstart` printed in UTC (`Mon Jan  2 15:04:05 2006`), as a decimal string; undefined when unparsable. */
export function utcSeconds(lstart: string): string | undefined {
	const fields = lstartFields(lstart);
	return fields ? String(Date.UTC(...fields) / 1000) : undefined;
}

/**
 * The start of `pid` (`utcSeconds`) and whether it is a zombie (it exited; only its parent has not reaped it yet), from
 * one asynchronous `ps`. Undefined when there is no such process or `ps` cannot tell (Windows, no `ps`, a timeout).
 */
export function processStartAsync(pid: number): Promise<{ started: string; zombie: boolean } | undefined> {
	if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		try {
			execFile(
				"ps",
				["-o", "stat=,lstart=", "-p", String(pid)],
				{ encoding: "utf8", timeout: 2000, windowsHide: true, env: PS_UTC_ENV() },
				(error, stdout) => {
					const match = error ? null : /^\s*(\S+)\s+(.*)$/.exec(stdout.trim());
					const started = match ? utcSeconds(match[2]) : undefined;
					resolve(match && started ? { started, zombie: match[1].startsWith("Z") } : undefined);
				},
			);
		} catch {
			resolve(undefined);
		}
	});
}
