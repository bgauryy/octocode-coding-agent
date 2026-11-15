import type { DbWriterRole } from "./protocol.ts";

/** The queue is full; nothing was sent, so the caller decides whether the work is needed later. */
export class DbWriterBusyError extends Error {
	readonly code = "DB_WRITER_BUSY";
}

/** The worker stopped before acknowledging: the command may or may not have committed, and nothing reports it either way. */
export class DbWriterUnavailableError extends Error {
	readonly code = "DB_WRITER_UNAVAILABLE";
}

/** The command failed; a stepped mirror save may have committed a partial copy. `busy` means a lock wait expired. */
export class DbWriterCommandError extends Error {
	readonly code = "DB_WRITER_COMMAND";
	readonly busy: boolean;
	constructor(message: string, busy: boolean) {
		super(message);
		this.busy = busy;
	}
}

/**
 * What a rejected `submit` means for its caller: `queue-full` (nothing was sent; try again after `drain`), `unavailable`
 * (the worker stopped before acknowledging), `db-busy` (another connection held the database past the wait) or `failed`
 * (the command ran and failed). Undefined for an error that did not come from a writer.
 */
export type DbWriterErrorKind = "queue-full" | "unavailable" | "db-busy" | "failed";

/** The kind of a writer error: callers branch on this instead of reading the errors' fields. */
export function writerErrorKind(error: unknown): DbWriterErrorKind | undefined {
	if (error instanceof DbWriterBusyError) return "queue-full";
	if (error instanceof DbWriterUnavailableError) return "unavailable";
	if (error instanceof DbWriterCommandError) return error.busy ? "db-busy" : "failed";
	return undefined;
}

/** Why a writer runs commands on the calling thread. */
export type DbWriterFallback = "bun" | "start-failed" | "load-failed" | "crashed" | "closed";

/** What a writer did on the calling thread instead of its worker, for status and diagnostics. */
export interface DbWriterStats {
	role: DbWriterRole;
	mode: "worker" | "inline";
	/** Why it runs inline; absent while its worker serves. */
	fallback?: DbWriterFallback;
	/** Commands sent and not yet acknowledged. */
	pending: number;
	restarts: number;
	/** Commands run on the calling thread, their total and longest duration in milliseconds. */
	inlineRuns: number;
	inlineMs: number;
	inlineMaxMs: number;
}
