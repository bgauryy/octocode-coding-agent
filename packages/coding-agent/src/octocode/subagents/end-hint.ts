import { USER_SENDER } from "../shared/messages.ts";
import type { EndReason } from "../team/session/end-reason.ts";
import type { AgentRuns } from "./claim.ts";
import type { BackgroundRun } from "./command.ts";

/** Why a run someone stopped ends: the user (Esc, `/agents kill`) stopped it, or an agent or the session did (`coordinate stop`, a permission change, shutdown). */
export const stopReason = (by: string | undefined): EndReason =>
	by === undefined || by === USER_SENDER ? "stopped-user" : "stopped-parent";

/**
 * Leaves the cause of a run's end on its team row, so that if the child dies without leaving, whoever retires the row names
 * it instead of `crashed`. Advisory: it never fails the run it describes.
 */
export function hintEnd(runs: Pick<AgentRuns, "team">, id: string, reason: EndReason): void {
	// Never throws: without the hint the row is retired as `left` or `crashed`, as before it existed.
	runs.team.audit.hint(id, reason);
}

/** Writes the stop hint the moment the run is aborted: the abort event runs inside `abort()`, after `stoppedBy` was set and before the child is signalled. */
export function hintOnStop(runs: Pick<AgentRuns, "team">, id: string, entry: BackgroundRun): void {
	entry.controller.signal.addEventListener("abort", () => hintEnd(runs, id, stopReason(entry.stoppedBy)), {
		once: true,
	});
}
