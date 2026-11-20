import { renderPrompt } from "../prompt-template.ts";

/** The heading of a summary's closing label, and the line inside it that lists keywords (the archive index reads both). */
export const TLDR_HEADING = "## TL;DR";
/** The section a split turn's prefix summary takes in the checkpoint (`turn-prefix.md` writes its subsections). */
export const TURN_CONTEXT_HEADING = "## Turn Context (split turn)";
/** The heading of a summary's first section: what the user is trying to accomplish. */
export const GOAL_HEADING = "## Goal";
/** The section of standing rules code carries from summary to summary until one is lifted (`ledger.ts`). */
export const CONSTRAINTS_HEADING = "## Constraints & Preferences";
/** The section of decisions code carries from summary to summary until one is superseded (`ledger.ts`). */
export const DECISIONS_HEADING = "## Key Decisions";
/** The section of failures and their lessons; memory queues its bullets as candidates (`memory/file/candidates.ts`). */
export const ERRORS_HEADING = "## Errors & Fixes";
const TOPICS_LABEL = "Topics:";
/** The section that says where the work stopped: a cut-off summary that still has it is kept (`checkpoint-format.md`). */
export const STOPPED_HEADING = "## Where We Stopped";

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
export const SUMMARY_CHECKPOINT_FORMAT = renderPrompt("workflows/compaction/checkpoint-format.md", {
	goalHeading: GOAL_HEADING,
	constraintsHeading: CONSTRAINTS_HEADING,
	decisionsHeading: DECISIONS_HEADING,
	errorsHeading: ERRORS_HEADING,
	stoppedHeading: STOPPED_HEADING,
	tldrHeading: TLDR_HEADING,
	topicsLabel: TOPICS_LABEL,
});

/**
 * `checkpoint` with a split turn's prefix summary as its own section, placed before the closing TL;DR so that stays the
 * summary's last section (the archive index reads it); appended when the checkpoint has none.
 */
export function withTurnContext(checkpoint: string, turnPrefix: string): string {
	const section = `${TURN_CONTEXT_HEADING}\n\n${turnPrefix.trim()}`;
	const lines = checkpoint.split("\n");
	const at = lines.findIndex((line) => line.trim() === TLDR_HEADING);
	if (at < 0) return `${checkpoint}\n\n${section}`;
	const before = lines.slice(0, at).join("\n").trimEnd();
	return `${before}\n\n${section}\n\n${lines.slice(at).join("\n")}`;
}

/**
 * The size target of an updated summary, said in the request and never in the cached system prompt. Empty without a
 * target to give.
 */
export function summarySizeTarget(tokens: number): string {
	return tokens > 0 ? renderPrompt("workflows/compaction/size-target.md", { tokens }) : "";
}
