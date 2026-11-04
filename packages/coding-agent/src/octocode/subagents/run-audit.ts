import { firstLine } from "../shared/util.ts";
import type { EndReason } from "../team/session/end-reason.ts";
import type { AgentRuns, Run } from "./claim.ts";

/** The `B<n>` number of a backlog item ref of this workspace (`agent` `item`), or undefined for any other text. */
const itemNumber = (ref: string | undefined): number | undefined => {
	const digits = /^B(\d+)$/i.exec(ref?.trim() ?? "")?.[1];
	return digits ? Number(digits) : undefined;
};

/**
 * The run starts: its audit row (`agent_runs`) opens with who started it, the profile, model, goal and the backlog item it is
 * for, so the child's own join only adds what the child knows. Advisory, like the hint: it never fails the run.
 */
export function beginRun(runs: Pick<AgentRuns, "team">, run: Run): void {
	const { identity, route } = run;
	const item = itemNumber(identity.item);
	runs.team.audit.begin({
		agentId: identity.id,
		...(identity.parentId ? { parentAgentId: identity.parentId } : {}),
		startedBy: "agent",
		profile: identity.role,
		...(route.model ? { model: route.model } : {}),
		goal: identity.goal,
		...(item === undefined ? {} : { item }),
	});
}

/** How a run ended, as its parent saw it: the end reason (`EndReason`), the child's own words for it and the report's facts. */
export interface RunEnd {
	reason: EndReason;
	error?: string | undefined;
	outcome?: string | undefined;
	outcomeSource?: string | undefined;
	reportPath?: string | undefined;
}

/** The parent's word on the run: its outcome and report, and its end when no agent row is left to retire (the child never joined). */
export function finishRun(runs: Pick<AgentRuns, "team">, id: string, end: RunEnd): void {
	runs.team.audit.finish(id, {
		endReason: end.reason,
		...(end.error ? { endDetail: firstLine(end.error) } : {}),
		outcome: end.outcome,
		outcomeSource: end.outcomeSource,
		reportPath: end.reportPath,
	});
}
