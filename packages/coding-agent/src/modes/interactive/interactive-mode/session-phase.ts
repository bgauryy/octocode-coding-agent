/**
 * The session's phase as the host reads it: from the application state, never from the footer or the feature API. The
 * terminal's program status (OSC 7501) and tab progress (OSC 9;4) follow the session's activity light (`activity`, which
 * the footer and the web read too): progress shows exactly while the light is working (a run, compaction, a retry,
 * background agents or a wake), and a pending timer alone is idle, as the light shows it (RFC app-state, T2 and Q1).
 */

import type { ActivityFacts } from "@octocodeai/octocode-projections";
import { watchSelection } from "@octocodeai/octocode-tui";
import type { ApplicationRuntimeState, ApplicationStateSource } from "../../../core/application/state.ts";
import type { InteractiveModeHost } from "./host.ts";

export type SessionPhaseHost = Pick<InteractiveModeHost, "programStatus">;

/** The facts the light reads, picked from the application state; a new object only when one of them changed. */
const factsOf = ({ phase, awaiting, status, streaming }: ApplicationRuntimeState): ActivityFacts => ({
	phase,
	awaiting,
	status,
	streaming,
});
const sameFacts = (a: ActivityFacts, b: ActivityFacts) =>
	a.phase === b.phase && a.awaiting === b.awaiting && a.status === b.status && a.streaming === b.streaming;

/**
 * Follows the light of `source` into the terminal's program status, which shows it (OSC 7501) and keeps the tab progress
 * (OSC 9;4) on while it is working. Binding a session reads no settings: the reporter writes only what changed. Returns
 * the function that stops it.
 */
export function bindSessionPhase(host: SessionPhaseHost, source: ApplicationStateSource): () => void {
	host.programStatus.setPhase(factsOf(source.getState()));
	return watchSelection(source, factsOf, (facts) => host.programStatus.setPhase(facts), sameFacts);
}
