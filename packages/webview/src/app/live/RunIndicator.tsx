import { useElapsed } from "../hooks.ts";
import { span } from "../model/format.ts";
import { SparkIcon } from "../ui/icons.tsx";
import type { RunPhase } from "./model.ts";

const LABELS = { thinking: "Thinking", writing: "Writing response" } as const;

/**
 * What the run is doing right now, with its elapsed time. Derived from the run state, not from model reasoning text,
 * which the application protocol does not carry. Not a live region: the session announcer reports start and finish.
 */
export function RunIndicator({ phase, startedAt }: { phase: RunPhase; startedAt: number }) {
	const elapsed = useElapsed(startedAt, phase.kind !== "idle");
	if (phase.kind === "idle") return null;
	return (
		<div className={`run-indicator phase-${phase.kind}`}>
			<span className="run-orb" aria-hidden="true" />
			<span className="shimmer">{phase.kind === "tool" ? `Running ${phase.name}` : LABELS[phase.kind]}</span>
			<span className="run-elapsed">{span(elapsed)}</span>
		</div>
	);
}

export function ThoughtFor({ ms }: { ms: number }) {
	return (
		<span className="thought-for">
			<SparkIcon size={12} />
			Thought for {span(ms)}
		</span>
	);
}

/** A live-updating duration for something still running. */
export function Elapsed({ since, prefix = "" }: { since: number; prefix?: string }) {
	const elapsed = useElapsed(since, true);
	return (
		<span className="elapsed">
			{prefix}
			{span(elapsed)}
		</span>
	);
}
