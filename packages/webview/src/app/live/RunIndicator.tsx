import { useState } from "react";
import { useElapsed } from "../hooks.ts";
import { span } from "../model/format.ts";
import { SparkIcon, TerminalIcon } from "../ui/icons.tsx";
import { StateMark } from "../ui/StateMark.tsx";
import type { RunPhase } from "./model.ts";
import { jobWords } from "./phase-words.ts";

const LABELS = {
	thinking: "Thinking",
	writing: "Writing response",
	compacting: "Compacting context",
	retrying: "Retrying request",
	stalled: "Model not answering",
} as const;

/** The small shape that tells phases apart beside the label, so colour is not the only cue. */
function PhaseIcon({ phase }: { phase: Exclude<RunPhase, { kind: "idle" }> }) {
	switch (phase.kind) {
		case "thinking":
			return <SparkIcon size={13} />;
		case "tool":
			return <TerminalIcon size={13} />;
		case "writing":
			return (
				<span className="phase-cursor" aria-hidden="true">
					▍
				</span>
			);
		default:
			return null;
	}
}

/**
 * What the session is doing right now, with its elapsed time. Derived from the run state and the host's session phase
 * (a job that goes on after the run settled shows what it waits on and counts from the job's start), not from model reasoning
 * text, which the application protocol does not carry. Not a live region: the session announcer reports start and
 * finish. `stale` marks a view whose connection is down: the phase is the last known one and no longer animates.
 * Compaction and retries happen outside a run, so they count from when this view first showed them.
 */
export function RunIndicator({
	phase,
	startedAt,
	stale = false,
}: {
	phase: RunPhase;
	startedAt?: number;
	stale?: boolean;
}) {
	const [seen] = useState(() => Date.now());
	const elapsed = useElapsed(startedAt ?? seen, phase.kind !== "idle" && !stale);
	if (phase.kind === "idle") return null;
	return (
		<div className={`run-indicator phase-${phase.kind}${stale ? " is-stale" : ""}`}>
			{phase.kind === "waiting" ? (
				<StateMark state="waiting" />
			) : phase.kind === "job" ? (
				<StateMark state="running" />
			) : (
				<span className="run-orb" aria-hidden="true" />
			)}
			<PhaseIcon phase={phase} />
			<span className="shimmer">
				{phase.kind === "tool"
					? `Running ${phase.name}`
					: phase.kind === "job"
						? jobWords(phase.phase, (startedAt ?? seen) + elapsed)
						: phase.kind === "waiting"
							? `Waiting for you${phase.awaiting.id ? "" : " in the terminal"}${phase.awaiting.title ? `: ${phase.awaiting.title}` : ""}`
							: ("detail" in phase && phase.detail) || LABELS[phase.kind]}
			</span>
			{stale && <span className="muted">last known</span>}
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
