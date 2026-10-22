export const REPORT_MAX_BYTES = 8 * 1024;

/** The outcome a subagent leads its final report with; the prompt tells it so, and the parent reads it back. */
export const REPORT_STATUSES = ["done", "partial", "blocked", "failed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
