export const REPORT_MAX_BYTES = 8 * 1024;

/** The outcome a subagent leads its final report with; the prompt tells it so, and the parent reads it back. */
export const REPORT_STATUSES = ["done", "partial", "blocked", "failed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** What each outcome means, so a child picks by what it can still do: `blocked` is the one that waits for an answer. */
export const REPORT_STATUS_MEANING: Record<ReportStatus, string> = {
	done: "acceptance checks met",
	partial: "stopped before the Definition of Done, usable as it is, no answer pending",
	blocked: "a decision or access from your parent would let you continue",
	failed: "could not proceed",
};
