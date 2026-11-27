import { isPendingApplicationPhase, type ApplicationPhase } from "@octocodeai/octocode-contracts";
import { span } from "../model/format.ts";

/** A phase that keeps the job going while no run is active: background work, a pending wake, or a timer. */
export type JobPhase = Extract<ApplicationPhase, { state: "waiting" | "resuming" | "scheduled" }>;

/** The job phase of a snapshot's phase, or undefined when the phase is running, blocked or final. */
export function jobPhaseOf(phase: ApplicationPhase | undefined): JobPhase | undefined {
	return phase && isPendingApplicationPhase(phase) ? (phase as JobPhase) : undefined;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** `2 agents (fix report, lock status, +1)`: the first names, each cut to one short line. */
const named = (words: string, names: readonly string[] | undefined) => {
	if (!names || names.length === 0) return words;
	const shown = names.slice(0, 3).map((name) => (name.length > 40 ? `${name.slice(0, 39)}…` : name));
	return `${words} (${shown.join(", ")}${names.length > 3 ? `, +${names.length - 3}` : ""})`;
};

/** What the job waits on, in the words the terminal's live line uses; a timer shows its countdown against `now`. */
export function jobWords(phase: JobPhase, now: number): string {
	switch (phase.state) {
		case "waiting": {
			const parts = [
				...(phase.agents > 0 ? [named(count(phase.agents, "agent"), phase.names?.agents)] : []),
				...(phase.queued > 0 ? [`${phase.queued} queued`] : []),
				...(phase.bash > 0 ? [named(`${phase.bash} bash`, phase.names?.bash)] : []),
				...(phase.external > 0 ? [`${phase.external} external`] : []),
			];
			return `Waiting on ${parts.join(" · ")}`;
		}
		case "resuming":
			return phase.label ? `Resuming: ${phase.label}` : "Resuming";
		case "scheduled": {
			const what = phase.timers > 1 ? `${phase.timers} timers` : `timer ${phase.id}`;
			const label = phase.label ? `${phase.label.length > 60 ? `${phase.label.slice(0, 59)}…` : phase.label} · ` : "";
			return `Waiting for ${label}${what}${phase.dueAt === undefined ? "" : ` · in ${span(Math.max(0, phase.dueAt - now))}`}`;
		}
	}
}
