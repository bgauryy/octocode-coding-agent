import { declaredTimeout } from "./event-text.ts";
import type { WorkWait } from "./pending-waits.ts";

interface DeadlineState {
	workWaits: WorkWait[];
	toolDeadlines: Map<unknown, number>;
	declaredUntil: number;
	jobsUntil: number;
	jobsMs: number;
}

/** After wait settlement, retain deadlines only for calls and jobs that still own them. */
export function noteDeadlines(state: DeadlineState, event: Record<string, unknown>, now: number): void {
	const { type, toolCallId } = event;
	if (type === "turn_start" || type === "message_update") state.toolDeadlines.clear();
	if (type === "tool_execution_start") {
		const own = declaredTimeout(event.args);
		if (own !== undefined) {
			state.toolDeadlines.set(toolCallId, now + own);
			const wait = state.workWaits.findLast((wait) => wait.kind === "job" && wait.call === toolCallId);
			if (event.toolName === "bash" && wait) {
				wait.until = now + own;
				wait.timeoutMs = own;
			}
		}
	} else if (type === "tool_execution_end") {
		const until = state.toolDeadlines.get(toolCallId);
		state.toolDeadlines.delete(toolCallId);
		const wait = state.workWaits.find((wait) => wait.kind === "job" && wait.call === toolCallId);
		if (event.toolName === "bash" && wait && until !== undefined) {
			// A foreground handoff keeps its original deadline, not another full timeout from the handoff.
			wait.until = until;
			wait.timeoutMs ??= Math.max(0, until - now);
		}
	}
	state.declaredUntil = 0;
	for (const [call, until] of state.toolDeadlines)
		if (!state.workWaits.some((wait) => wait.kind === "job" && wait.call === call))
			state.declaredUntil = Math.max(state.declaredUntil, until);
	state.jobsUntil = 0;
	state.jobsMs = 0;
	for (const wait of state.workWaits) {
		if (wait.kind !== "job") continue;
		state.jobsUntil = Math.max(state.jobsUntil, wait.until ?? 0);
		state.jobsMs = Math.max(state.jobsMs, wait.timeoutMs ?? 0);
	}
}
