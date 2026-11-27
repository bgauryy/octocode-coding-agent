import { renderPrompt } from "../../../core/prompt-template.ts";
import { shortPath } from "../../../utils/display-path.ts";
import type { Report } from "./pending.ts";

/** The outcome word of a report as the parent reads it: the child's named outcome, else the run's end state. */
const resultOf = (report: Report): string => {
	const { outcome, status } = report.details;
	return outcome ?? (status === "done" ? "finished" : status);
};

/**
 * Whether a parent mid-turn learns of this report before the turn ends. A clean finish waits for the report that
 * arrives with the turn's end; any other outcome (blocked, partial, failed, stopped) may change what the parent does
 * next, so it reads a notice at its next step.
 */
export const noticeWanted = (report: Report): boolean => {
	const result = resultOf(report);
	return result !== "done" && result !== "finished";
};

/** The notice for a parent mid-turn. The path is the saved full report when the report was long enough to be saved. */
export function noticeText(report: Report): string {
	// The pointer is the last such line, after anything the child wrote; only a scratch path is ever repeated.
	// The host's own report file: the report text is the child's, and may imitate a pointer line.
	const saved = report.details.reportArtifact?.path;
	const file = saved ? shortPath(saved) : undefined;
	return renderPrompt("notices/subagents/report-waiting.md", { id: report.details.id, result: resultOf(report), file });
}
