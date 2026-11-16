import type { ExtensionAPI } from "../../../core/features/index.ts";
import { AGENT_RESULT_TYPE } from "../../shared/messages.ts";
import { wakeGateOf } from "../../wake/gate.ts";
import type { Report } from "./pending.ts";

/**
 * A child's report. `triggerTurn` is this send's own (only the last send of an idle batch starts the turn); the row follows
 * the report's `wake`, so every report of a waking batch is listed.
 */
export function sendAgentReport(
	api: ExtensionAPI,
	report: Report,
	details: object,
	item: string | undefined,
	triggerTurn: boolean,
): void | Promise<void> {
	const { details: result } = report;
	return wakeGateOf(api).emit(
		{
			kind: "agent.report",
			agent: result.id,
			role: result.profile ?? "agent",
			outcome: result.outcome ?? result.status,
			...(item ? { item } : {}),
			reportId: report.reportId ?? result.id,
		},
		{ customType: AGENT_RESULT_TYPE, content: report.content, display: true, details },
		{ triggerTurn, deliverAs: "followUp", together: true },
		report.wake,
	);
}
