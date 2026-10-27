import type { UiState } from "../../theme/status.ts";
import type { ResultDetails, RunDetails } from "./run-types.ts";

/**
 * The design state of an agent row's mark. A run that works is `running`, and `waiting` while its child needs the user's
 * answer; a finished one maps its outcome: `blocked` (needs input) is `waiting`, `failed` is `failed`, a stop is
 * `stopped`, anything else (`done`, `partial`, no outcome) is `done`. Drawing only: the report the model reads is unchanged.
 */
export function agentState(
	details:
		| Partial<Pick<RunDetails, "status" | "waiting" | "outcome">>
		| Partial<Pick<ResultDetails, "status" | "outcome">>,
): UiState {
	const { status, outcome } = details;
	if (status === "failed" || outcome === "failed") return "failed";
	if (status === "stopped") return "stopped";
	if (outcome === "blocked") return "waiting";
	if ("waiting" in details && details.waiting && status === "running") return "waiting";
	// A background launch is a finished call (the agent's own row is in the panel); only a foreground run spins here.
	if (status === "running" || status === "waiting") return "running";
	return "done";
}

/** The part of `agentState` a header cannot work out itself: `waiting` and `failed`; the rest is its phase's mark. */
export const headerOverride = (state: UiState): UiState | undefined =>
	state === "waiting" || state === "failed" ? state : undefined;
