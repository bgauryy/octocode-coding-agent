import { envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { TOOL_FOREGROUND_MS } from "../jobs/registry.ts";
import { textResult } from "../shared/util.ts";
import type { AgentRuns, Run } from "./claim.ts";
import type { HandOver } from "./foreground-budget.ts";
import { routeSummary } from "./model.ts";
import type { SubagentOutcome } from "./process/outcome.ts";
import { startBackground } from "./run-execution.ts";
import type { RunDetails } from "./run-types.ts";
import type { AgentUpdate } from "./tracking.ts";

export interface ForegroundHandOver {
	/** The call's progress callback; it goes quiet once the call has returned. */
	onUpdate: AgentUpdate | undefined;
	handOver: HandOver;
}

interface HandOverCall {
	runs: AgentRuns;
	run: Run;
	details: RunDetails;
	task: string;
	finish: (outcome?: SubagentOutcome, lingers?: boolean, stopped?: boolean) => Promise<string>;
	sessionId: string;
	/** The worktree and team notes the call's result carries. */
	warning: string;
	onUpdate: AgentUpdate | undefined;
}

/**
 * The hand-over of a foreground call, or undefined when the call must wait: a subagent's own `agent` calls (nothing
 * would read a report after its answer) and the callers that need the report in the same call (`holdTurn`).
 */
export function foregroundHandOver(call: HandOverCall, holdTurn: boolean): ForegroundHandOver | undefined {
	if (holdTurn || envFlag(process.env, SUBAGENT_ENV)) return undefined;
	let returned = false;
	return {
		onUpdate: call.onUpdate && ((update) => !returned && call.onUpdate?.(update)),
		handOver: {
			afterMs: TOOL_FOREGROUND_MS,
			takeOver: (running, controller) => {
				returned = true;
				const { runs, run, details } = call;
				startBackground(
					runs,
					run,
					details,
					call.task,
					() => running,
					call.finish,
					call.sessionId,
					undefined,
					controller,
				);
				details.status = "background";
				const seconds = Math.round(TOOL_FOREGROUND_MS / 1000);
				return textResult(
					`${run.identity.id} (${run.identity.role}) is still running after ${seconds}s, so it continues in the background; its report arrives as a message. Runs on ${routeSummary(run.route)}.${call.warning}`,
					details,
				);
			},
		},
	};
}
