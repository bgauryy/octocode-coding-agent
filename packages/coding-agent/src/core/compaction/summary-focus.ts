import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { renderPrompt } from "../prompt-template.ts";

/**
 * The focus a compaction's summary is asked to keep beside the required rules, labelled by who wrote it: the user (`/compact
 * <focus>`, RPC, SDK) or the agent itself (its `compact` tool). The agent's focus is its own notes on what it needs next,
 * so the summarizer must not record it as the user's words. A plain string is the user's.
 */
export type FocusSource = "user" | "agent";

export interface SummaryFocus {
	text: string;
	source: FocusSource;
}

/** A focus given as text (the user's) or labelled; undefined when there is none or it is blank. */
function summaryFocus(focus: string | SummaryFocus | undefined): SummaryFocus | undefined {
	const labelled = typeof focus === "string" ? { text: focus, source: "user" as const } : focus;
	return labelled?.text.trim() ? labelled : undefined;
}

/** The focus as the summary request states it, under a label naming its author; empty without one. */
export function focusBlock(focus: string | SummaryFocus | undefined): string {
	const labelled = summaryFocus(focus);
	return labelled
		? renderPrompt("workflows/compaction/extra-focus.md", { agent: labelled.source === "agent", text: labelled.text })
		: "";
}

/** What a compaction entry records of its focus: who wrote it, its length and a hash, never the text itself. */
export interface FocusRecord {
	source: FocusSource;
	chars: number;
	sha256: string;
}

export function focusRecord(focus: string | SummaryFocus | undefined): FocusRecord | undefined {
	const labelled = summaryFocus(focus);
	return labelled ? { source: labelled.source, chars: labelled.text.length, sha256: sha256(labelled.text) } : undefined;
}
