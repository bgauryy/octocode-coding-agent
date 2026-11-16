import type { Usage } from "@octocodeai/octocode-ai";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import { addUsage, finiteNumber } from "../shared/util.ts";

/** What a child's compactions came to (Octocode's `compaction_start` / `compaction_end`): counted, never dropped, so a report can say how often and how well. */
export interface Compactions {
	/** Compactions that produced a summary. */
	done: number;
	/** Compactions stopped before they finished (the child was aborted, or an extension cancelled it). */
	aborted: number;
	/** Compactions that failed; `error` is the latest message. */
	failed: number;
	error?: string;
	/** Context size in tokens before and after the latest finished compaction. */
	tokensBefore?: number;
	tokensAfter?: number;
}

/** A compaction ended: counts it, and adds the summary's own model usage to the run (it is no reply, so no `message_end` carries it). */
export function endCompaction(tally: Compactions, usage: Usage, event: Record<string, unknown>): void {
	const result = event.result;
	if (isRecord(result)) {
		tally.done += 1;
		const [before, after] = [finiteNumber(result.tokensBefore), finiteNumber(result.estimatedTokensAfter)];
		if (before !== undefined) tally.tokensBefore = before;
		if (after !== undefined) tally.tokensAfter = after;
		addUsage(usage, result.usage);
	} else if (event.aborted === true) tally.aborted += 1;
	else {
		tally.failed += 1;
		const message = event.errorMessage;
		tally.error = visibleControls(typeof message === "string" && message ? message : "compaction failed");
	}
}
