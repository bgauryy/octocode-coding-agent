import { renderPrompt } from "../../../core/prompt-template.ts";

/**
 * The most of a child's report the parent's context gets inline (`subagents/report.ts`); a longer report is saved whole
 * in the child's scratch folder and the preview ends with its path. Every later request of the parent sends the preview
 * again, so it holds the outcome and the lines the contract asks to keep within it, and long evidence goes to a file.
 */
export const REPORT_MAX_BYTES = 4 * 1024;

/** The outcome a subagent leads its final report with; the task tells it so, and the parent reads it back. */
export const REPORT_STATUSES = ["done", "partial", "blocked", "failed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** What each outcome means, so a child picks by what it can still do: `blocked` is the one that waits for an answer. */
const REPORT_STATUS_MEANING: Record<ReportStatus, string> = {
	done: "acceptance checks met",
	partial: "ended before the Definition of Done, usable as it is, no answer pending",
	blocked: "a decision or access from your coordinator would let you continue",
	failed: "could not proceed",
};

const OUTCOMES = REPORT_STATUSES.map((status) => `${status} (${REPORT_STATUS_MEANING[status]})`)
	.join(", ")
	.replace(/, ([^,]*)$/, " or $1");

/**
 * The report contract, as sentences (`subagent/report.md`, one per line). It is stated once, in every child's task
 * (`task.ts`), so the policy, the lean prompt and the role files do not carry it: the first word is what
 * `subagents/report.ts` parses, the preview size is what the parent keeps, and continuation depends on the run's
 * lifecycle, not just its outcome.
 */
function reportContractSentences(): string[] {
	return renderPrompt("subagent/report.md", { outcomes: OUTCOMES, previewKb: REPORT_MAX_BYTES / 1024 }).split("\n");
}

/** The report contract as the task states it. */
export function reportContract(): string {
	return reportContractSentences().join(" ");
}
