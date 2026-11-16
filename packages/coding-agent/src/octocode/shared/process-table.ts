import { execFile } from "node:child_process";
import { lstartFields, PS_UTC_ENV, utcSeconds } from "@octocodeai/octocode-common/process-start";

export { PS_UTC_ENV, utcSeconds };

/**
 * The process table read with one asynchronous `ps -A` (POSIX): pid, parent, group, state and start of every process.
 * Nothing here runs `ps` on the calling thread, so a timer or an exit path that needs it never stalls the screen.
 */

/** One process as `ps` listed it; `started` is whole seconds since the epoch (`utcSeconds`), undefined when unparsable. */
export interface ProcessRow {
	pid: number;
	ppid: number;
	pgid: number;
	/** `ps` state: a zombie (`Z…`) has exited already. */
	stat: string;
	started: string | undefined;
}

export interface ProcessTable {
	/** `Date.now()` when `ps` was started: every process it lists started at or before this. */
	at: number;
	rows: ReadonlyMap<number, ProcessRow>;
}

/** `ps` bound: a hung `ps` must not leave a sweep waiting forever. */
export const PS_TIMEOUT_MS = 2000;

/**
 * A recorded start time as seconds since the epoch: the decimal form `processStartTime` writes, or an older record's
 * `lstart` text printed in this machine's zone (before start times were zone free). Undefined when neither.
 */
export function startSeconds(started: string): number | undefined {
	if (/^\d+$/.test(started)) return Number(started);
	const fields = lstartFields(started);
	return fields ? new Date(...fields).getTime() / 1000 : undefined;
}

/** Runs `ps` without blocking; undefined when it fails (no `ps`, a timeout, Windows). */
export function psAsync(args: string[], env?: NodeJS.ProcessEnv): Promise<string | undefined> {
	if (process.platform === "win32") return Promise.resolve(undefined);
	return new Promise((resolve) => {
		try {
			execFile(
				"ps",
				args,
				{
					encoding: "utf8",
					timeout: PS_TIMEOUT_MS,
					maxBuffer: 64 * 1024 * 1024,
					windowsHide: true,
					...(env ? { env } : {}),
				},
				(error, stdout) => resolve(error ? undefined : stdout),
			);
		} catch {
			resolve(undefined);
		}
	});
}

/** A fresh table of every process (one `ps -A`), or undefined when `ps` cannot be read. Never rejects. */
export async function readProcessTable(): Promise<ProcessTable | undefined> {
	const at = Date.now();
	const text = await psAsync(["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], PS_UTC_ENV());
	if (text === undefined) return undefined;
	const rows = new Map<number, ProcessRow>();
	for (const line of text.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		rows.set(pid, {
			pid,
			ppid: Number(match[2]),
			pgid: Number(match[3]),
			stat: match[4],
			started: utcSeconds(match[5]),
		});
	}
	return { at, rows };
}

/** How long the shared table answers start-time questions before a read asks for a new one. */
export const TABLE_TTL_MS = 30_000;

let memo: ProcessTable | undefined;
let loading: Promise<ProcessTable | undefined> | undefined;

/** The last table read for the memo, however old; undefined before the first one arrived. */
export const memoTable = (): ProcessTable | undefined => memo;

/**
 * Reads the shared table again unless a read is already running (every caller then shares it): the one `ps -A` a sweep
 * or a burst of liveness questions costs. Resolves with the new table (the previous one when `ps` failed).
 */
export function refreshProcessTable(): Promise<ProcessTable | undefined> {
	loading ??= readProcessTable().then(
		(table) => {
			loading = undefined;
			if (table) memo = table;
			return memo;
		},
		() => {
			loading = undefined;
			return memo;
		},
	);
	return loading;
}

/** Tests: forget the shared table. */
export function resetProcessTable(): void {
	memo = undefined;
	loading = undefined;
}
