/**
 * The session's phase as the host reads it: from the application state, never from the footer or the feature API. While
 * the phase is waiting, resuming or scheduled, no run is active but the job goes on (background agents, a wake, a
 * timer), so the terminal's tab progress (OSC 9;4) and program status (OSC 7501) stay `working` until it is final.
 */

import { isPendingApplicationPhase, type ApplicationPhase } from "@octocodeai/octocode-contracts";
import { watchSelection } from "@octocodeai/octocode-tui";
import type { ApplicationStateSource } from "../../../core/application/state.ts";
import type { InteractiveModeHost } from "./host.ts";

export type SessionPhaseHost = Pick<InteractiveModeHost, "programStatus" | "session" | "settingsManager" | "ui">;

/** Whether the phase in `source` keeps the job going after the run settled. */
export function phaseKeepsJobGoing(source: ApplicationStateSource): boolean {
	const phase = source.getState().phase;
	return phase !== undefined && isPendingApplicationPhase(phase);
}

const samePhase = (a: ApplicationPhase | undefined, b: ApplicationPhase | undefined) =>
	JSON.stringify(a) === JSON.stringify(b);

/**
 * Follows the phase of `source`: the program status reports `working` while it is pending, and the tab progress follows
 * it when no run or compaction of the session shows progress itself. Returns the function that stops it.
 */
export function bindSessionPhase(host: SessionPhaseHost, source: ApplicationStateSource): () => void {
	const apply = (phase: ApplicationPhase | undefined, previous: ApplicationPhase | undefined) => {
		host.programStatus.setPhase(phase);
		const pending = phase !== undefined && isPendingApplicationPhase(phase);
		const wasPending = previous !== undefined && isPendingApplicationPhase(previous);
		if (pending === wasPending || host.session.isStreaming || host.session.isCompacting) return;
		if (host.settingsManager.getShowTerminalProgress()) host.ui.terminal.setProgress(pending);
	};
	apply(source.getState().phase, undefined);
	return watchSelection(source, (state) => state.phase, apply, samePhase);
}
