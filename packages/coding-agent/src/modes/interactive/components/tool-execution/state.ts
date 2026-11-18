import type { ToolExecutionResult } from "./types.ts";

/**
 * Where a tool call is in its life:
 *
 *   streaming ──args complete──▶ pending ──started──▶ running ──final result──▶ done | error
 *        │                          │                    │ ▲
 *        └──── final result ────────┴─── final result ───┘ └─ partial result (replaces the output)
 *
 * A final result may arrive from any live state (a call that never ran, or a replayed session); `ran` records whether
 * execution had started. A terminal state ignores late lifecycle events but a new result replaces its output.
 */
export type ToolPhase =
	| { phase: "streaming" }
	| { phase: "pending" }
	| { phase: "running"; result?: ToolExecutionResult }
	| { phase: "done"; result: ToolExecutionResult; ran: boolean }
	| { phase: "error"; result: ToolExecutionResult; ran: boolean };

export const initialToolPhase: ToolPhase = { phase: "streaming" };

export function argsCompleted(state: ToolPhase): ToolPhase {
	return state.phase === "streaming" ? { phase: "pending" } : state;
}

export function executionStarted(state: ToolPhase): ToolPhase {
	return state.phase === "streaming" || state.phase === "pending" ? { phase: "running" } : state;
}

export function resultReceived(state: ToolPhase, result: ToolExecutionResult, isPartial: boolean): ToolPhase {
	if (isPartial) return { phase: "running", result };
	const ran = state.phase === "running" || ((state.phase === "done" || state.phase === "error") && state.ran);
	return { phase: result.isError ? "error" : "done", result, ran };
}

export const isPartialPhase = (state: ToolPhase): boolean =>
	state.phase === "streaming" || state.phase === "pending" || state.phase === "running";

export const phaseArgsComplete = (state: ToolPhase): boolean => state.phase !== "streaming";

export const phaseExecutionStarted = (state: ToolPhase): boolean =>
	state.phase === "running" || ((state.phase === "done" || state.phase === "error") && state.ran);

export const phaseResult = (state: ToolPhase): ToolExecutionResult | undefined =>
	"result" in state ? state.result : undefined;

/** Two states that draw the same: a transition between them changes nothing on screen. */
export function samePhase(a: ToolPhase, b: ToolPhase): boolean {
	return (
		a === b ||
		(a.phase === b.phase && phaseResult(a) === phaseResult(b) && phaseExecutionStarted(a) === phaseExecutionStarted(b))
	);
}
