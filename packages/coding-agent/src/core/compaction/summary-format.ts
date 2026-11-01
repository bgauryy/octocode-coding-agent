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
export const SUMMARY_CHECKPOINT_FORMAT = `Write these sections, in this order, with the headings as given:

${GOAL_HEADING}
[What the user is trying to accomplish; several items when the session covers different tasks]

## Constraints & Preferences
- [Constraints, preferences or requirements the user stated, or "(none)"]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Work under way]

### Blocked
- [What prevents progress, if anything]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Errors & Fixes
- [Each error or failed approach: the exact error text, its cause, and the fix, or "unresolved". The user's corrections of the approach belong here.]

## Where We Stopped
- [The work under way in the last messages, with its exact file paths, and the assistant's last step. Name a next step only when it follows directly from the latest request; never start tangential work.]

## Critical Context
- [Data, examples or references needed to continue, or "(none)"]

${TLDR_HEADING}
One or two lines on what the summarized messages did, then a line "${TOPICS_LABEL} " with 3 to 8 comma-separated keywords. An index of the conversation's history uses it as this stretch's label.

Keep each section concise. Keep file paths, symbols, commands, error strings, URLs and identifiers exact.`;
