import { renderInstruction } from "../prompt-template.ts";

/** The heading of a summary's closing label, and the line inside it that lists keywords (the archive index reads both). */
export const TLDR_HEADING = "## TL;DR";
/** The heading of a summary's first section: what the user is trying to accomplish. */
export const GOAL_HEADING = "## Goal";
const TOPICS_LABEL = "Topics:";

/** The trimmed, non-empty lines of the section headed `heading`, up to the next heading or file-list tag; none when absent. */
export function summarySection(summary: string, heading: string): string[] {
	const lines = summary.split("\n");
	const start = lines.findIndex((line) => line.trim() === heading);
	if (start < 0) return [];
	const end = lines.findIndex((line, index) => index > start && /^(?:## |<)/.test(line));
	return lines
		.slice(start + 1, end < 0 ? undefined : end)
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * The one statement of the checkpoint a compaction summary is written in. The standalone prompts (`summarization.ts`,
 * `branch-summarization.ts`) and the cache-sharing request (`octocode/compaction/shared-summary.ts`) compose it; none
 * restates a section. It asks for judgment the next model cannot read back from a file: what is wanted, what was
 * decided, what went wrong and where the work stopped. What code attaches after the summary (file lists, saved
 * results, the user's own messages, recovery pointers) is not asked for.
 */
export const SUMMARY_CHECKPOINT_FORMAT = renderInstruction("workflows/compaction/checkpoint-format.md", {
	goalHeading: GOAL_HEADING,
	tldrHeading: TLDR_HEADING,
	topicsLabel: TOPICS_LABEL,
});

/**
 * The size target of an updated summary, said in the request and never in the cached system prompt. Empty without a
 * target to give.
 */
export function summarySizeTarget(tokens: number): string {
	return tokens > 0 ? renderInstruction("workflows/compaction/size-target.md", { tokens }) : "";
}
