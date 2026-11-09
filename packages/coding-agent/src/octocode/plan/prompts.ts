import { renderInstruction } from "../../core/prompt-template.ts";
import type { PlanState } from "../../core/plan-state.ts";

/** The `planning` section while planning is active (`octocode/instructions/workflows/planning.md`). */
export const PLANNING_INSTRUCTIONS = renderInstruction("workflows/planning.md");

/** Include the approved content: its original assistant message may have been compacted away. */
export function approvedPlanPrompt(plan: PlanState): string {
	return renderInstruction("workflows/plan-approved.md", {
		revision: plan.revision,
		record: JSON.stringify({ revision: plan.revision, plan: plan.text }),
	});
}

/** Custom message type of the plan reminder that follows a compaction. */
export const PLAN_REMINDER_TYPE = "octocode-plan-reminder";
const PLAN_REMINDER_CHARS = 8_000;

/** After a compaction: the plan being refined, since the summary may have dropped its wording. Data the user can still replace, not an instruction to implement. */
export function planReminder(plan: PlanState): string {
	const text =
		plan.text.length > PLAN_REMINDER_CHARS ? `${plan.text.slice(0, PLAN_REMINDER_CHARS)}\n[…clipped]` : plan.text;
	return renderInstruction("workflows/plan-reminder.md", { revision: plan.revision, text });
}
