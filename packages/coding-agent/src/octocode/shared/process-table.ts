import { PS_UTC_ENV, utcSeconds } from "@octocodeai/octocode-common/process-start";
import { type PsReadOptions, type PsRow, type PsSnapshot, PS_TIMEOUT_MS, readPsSnapshot } from "./ps-snapshot.ts";

export { PS_TIMEOUT_MS, PS_UTC_ENV, utcSeconds };

/**
 * The process table of `ps-snapshot.ts` (one asynchronous `ps -A`, shared for a second). Nothing here runs `ps` on
 * the calling thread, so a timer or an exit path that needs it never stalls the screen.
 */

/** One process as `ps` listed it; `started` is whole seconds since the epoch (`utcSeconds`), undefined when unparsable. */
export type ProcessRow = Pick<PsRow, "pid" | "ppid" | "pgid" | "stat" | "started">;

export type ProcessTable = PsSnapshot;

/** A recorded start time as seconds since the epoch: the decimal form `processStartTime` writes; undefined otherwise. */
export function startSeconds(started: string): number | undefined {
	return /^\d+$/.test(started) ? Number(started) : undefined;
}

/**
 * A table of every process (`readPsSnapshot`), or undefined when `ps` cannot be read. Never rejects. `fresh`: read
 * after this call, for a decision to signal or a process just started.
 */
export async function readProcessTable(options: PsReadOptions = {}): Promise<ProcessTable | undefined> {
	try {
		return await readPsSnapshot(options);
	} catch {
		// No `ps`, or it timed out: callers treat the table as unknown.
		return undefined;
	}
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
