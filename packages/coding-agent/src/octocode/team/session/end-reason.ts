import type { agentEvents } from "../../../../../db/src/api.ts";

/** How an agent ended its life in the team, as the leaver names it (`agentEvents.END_REASONS`). */
export type EndReason = agentEvents.EndReason;

/**
 * The reason a finished subagent run gives when it leaves: its run completed or failed. An abort says nothing here:
 * whoever stopped it left a hint on the row (`stopped-user`, `stopped-parent`), else it is `left`.
 */
export function settleReason(status: string | undefined): EndReason | undefined {
	if (status === "completed" || status === "truncated") return "completed";
	return status === "failed" ? "failed" : undefined;
}
