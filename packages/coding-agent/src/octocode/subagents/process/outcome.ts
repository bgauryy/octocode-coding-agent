import type { Usage } from "@octocodeai/octocode-ai";
import type { ReportStatus } from "../../instructions/report.ts";
import type { WatchdogLimits } from "../events.ts";
import type { StructuredResultV1 } from "../result-schema.ts";
import type { ReportArtifact } from "../../child-sessions/report-artifact.ts";

/** How long a stopped subagent gets to exit after SIGTERM before it is killed (a session shutdown, a permission change, a stall). */
export const SUBAGENT_STOP_GRACE_MS = 5_000;
/** The same for a stop the user asked for (Esc, `/agents kill`): the row frees at once instead of after the full grace. */
export const USER_STOP_GRACE_MS = 1_000;
/** How long an aborted child gets to report `agent_settled` before the stop falls back to signals. */
export const ABORT_SETTLE_MS = 1_000;
/** Abort reason of a stop the user asked for; any other reason gets the full grace. */
export const USER_STOP = "user stop";
/** JSON events can contain images; a malformed child must not grow an unterminated frame forever. */
export const MAX_EVENT_BYTES = 16 * 1024 * 1024;

/** After the child exits, how long its stdio gets to drain before the run settles without waiting for `close` (a grandchild may hold the pipes open). */
export const EXIT_GRACE_MS = 1_000;

/** A model stream silent this long has stalled; busy time is bounded by each call's own deadline, else 15 minutes (bash's default). */
export const WATCHDOG: WatchdogLimits = { idleMs: 10 * 60_000, busyMs: 15 * 60_000 };

/** The error of a child that exited cleanly without a final answer: a no-op run is a failure, not a finished task. */
const NO_ANSWER = "Subagent ended without a final answer (it exited cleanly with no text)";

/** {@link NO_ANSWER}, with the last error the child reported: a run the loop guard ended, say, gets no turn to explain itself. */
export const noAnswerError = (lastError: string | undefined): string =>
	lastError ? `${NO_ANSWER}. Its last error: ${lastError}` : NO_ANSWER;

/** Why a child ended without a usable answer: its exit code, or the signal that killed it. */
export function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
	return code === null && signal ? `was killed by ${signal}` : `exited with code ${code ?? "unknown"}`;
}

export interface SubagentOutcome {
	text: string;
	structured?: StructuredResultV1;
	reportArtifact?: ReportArtifact;
	outcome?: ReportStatus;
	/** Where the report named `outcome`: its first word or a labelled last line. */
	outcomeSource?: "first" | "last";
	usage: Usage;
	/** Set when the child's model call failed (stopReason error/aborted). */
	error?: string;
	/** Set when the request budget stopped the run (`budget.ts`): the replies it made and the soft limit. */
	budget?: { requests: number; limit: number };
}

/** Wait before the one retry of a child that crashed while loading its code (a source file being edited at that moment). */
export const STARTUP_RETRY_DELAY_MS = 1_500;
/** Stderr of a crash while loading: a module or syntax error, which a moment later may be gone. */
export const LOAD_ERROR = /ERR_|SyntaxError|Cannot find module/;

/**
 * A child that exited before its first model turn: nothing ran, so `retryable` (a module-load error in its stderr) says
 * whether a second start may work. `reason` is the one error line the message carries; `stderrFile` holds the whole stderr.
 */
export class StartupError extends Error {
	readonly retryable: boolean;
	readonly reason: string | undefined;
	readonly stderrFile: string | undefined;
	constructor(message: string, retryable: boolean, reason?: string, stderrFile?: string) {
		super(message);
		this.name = "StartupError";
		this.retryable = retryable;
		this.reason = reason;
		this.stderrFile = stderrFile;
	}
}
