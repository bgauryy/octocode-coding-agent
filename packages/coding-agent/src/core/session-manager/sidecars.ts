import path from "node:path";

/** The model's summary paid for by a compaction that did not finish, kept so a resume does not pay again. */
export const paidSummaryFile = (sessionFile: string) => `${sessionFile}.paid-summary.json`;

/** Whether `name`, a file beside `sessionFile`, holds that session's paid summary. */
export const isPaidSummaryOf = (sessionFile: string, name: string) =>
	name === path.basename(paidSummaryFile(sessionFile));
