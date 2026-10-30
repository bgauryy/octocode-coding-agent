export const REPORT_MAX_BYTES = 8 * 1024;

/** The outcome a subagent leads its final report with; the task tells it so, and the parent reads it back. */
export const REPORT_STATUSES = ["done", "partial", "blocked", "failed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** What each outcome means, so a child picks by what it can still do: `blocked` is the one that waits for an answer. */
export const REPORT_STATUS_MEANING: Record<ReportStatus, string> = {
	done: "acceptance checks met",
	partial: "ended before the Definition of Done, usable as it is, no answer pending",
	blocked: "a decision or access from your parent would let you continue",
	failed: "could not proceed",
};

const OUTCOMES = REPORT_STATUSES.map((status) => `${status} (${REPORT_STATUS_MEANING[status]})`)
	.join(", ")
	.replace(/, ([^,]*)$/, " or $1");

/**
 * The report contract, as sentences. It is stated once, in every child's task (`task.ts`), so the policy, the lean
 * prompt and the role files do not carry it: the first word is what `subagents/report.ts` parses, the preview size is
 * what the parent keeps, and continuation depends on the run's lifecycle, not just its outcome.
 */
export function reportContractSentences(): string[] {
	return [
		"Your final answer is your report and reaches your parent by itself.",
		`Start it with one word: ${OUTCOMES}, then the result, verification and open questions.`,
		"For partial or blocked work, include current state, evidence, blockers and the next action.",
		"End a `blocked` report with its question. Only a non-isolated background run can continue by message while it remains reachable; foreground runs need an explicit task resume, and isolated runs need a new agent with recovery context.",
		`Your parent keeps the first ${REPORT_MAX_BYTES / 1024} KB and gets the path of the whole report in your scratch folder.`,
	];
}

/** The report contract as the task states it. */
export function reportContract(): string {
	return reportContractSentences().join(" ");
}
