import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { SessionEntry } from "../session-manager.ts";
import type { CompactionRequester } from "./manual-options.ts";
import { type FocusRecord, focusRecord, type SummaryFocus } from "./summary-focus.ts";

/**
 * What a compaction entry records about how it went, in its `details`, so its effect and cost are read from the entry
 * instead of joined from the transcript: what started it, the focus it was given (who wrote it, its length and a hash),
 * the context it left (estimated when it was saved) and the summary attempts that paid for it.
 */

/** The usage kind of a summary request (`createSessionUsageRecorder`). */
const COMPACTION_ATTEMPT_KIND = "compaction_attempt";

/** What started a compaction: the context threshold, an overflow, or a request by the user or by the agent itself. */
type CompactionTrigger = "threshold" | "overflow" | CompactionRequester;

interface CompactionOutcome {
	trigger: CompactionTrigger;
	focus?: FocusRecord;
	/** The context the next request sends, estimated from the session as saved with this compaction. */
	estimatedTokensAfter: number;
	/** The `compaction_attempt` usage entries this compaction paid for: its own run's, and any a feature names. */
	attemptIds: string[];
}

/** The `details` key under which a feature names summary attempts it paid before the run (an early summary). */
export const ATTEMPT_IDS_DETAILS = "attemptIds";

/** The ids of the summary attempts recorded on `branch` at or after `since` (ISO), newest last. */
export function compactionAttemptIds(branch: readonly SessionEntry[], since: string): string[] {
	const from = Date.parse(since);
	const ids: string[] = [];
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (Date.parse(entry.timestamp) < from) break;
		if (entry.type === "usage" && entry.kind === COMPACTION_ATTEMPT_KIND) ids.unshift(entry.id);
	}
	return ids;
}

/** `details` with the outcome added; a feature's attempt ids are kept beside the run's. */
export function withOutcome(
	details: unknown,
	outcome: {
		trigger: CompactionTrigger;
		focus: SummaryFocus | undefined;
		estimatedTokensAfter: number;
		attemptIds: string[];
	},
): unknown {
	if (details !== undefined && !isRecord(details)) return details;
	const named = details?.[ATTEMPT_IDS_DETAILS];
	const earlier = Array.isArray(named) ? named.filter((id): id is string => typeof id === "string") : [];
	const focus = focusRecord(outcome.focus);
	const recorded: CompactionOutcome = {
		trigger: outcome.trigger,
		...(focus ? { focus: { ...(isRecord(details?.focus) ? details.focus : {}), ...focus } } : {}),
		estimatedTokensAfter: outcome.estimatedTokensAfter,
		attemptIds: [...new Set([...earlier, ...outcome.attemptIds])],
	};
	return { ...details, ...recorded };
}
