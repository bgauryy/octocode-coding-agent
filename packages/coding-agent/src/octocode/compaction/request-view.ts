import { sessionCleared, sessionClearedAt } from "../files/reads.ts";
import type { BranchSource } from "../shared/branch-index.ts";
import { summaryMethodOf } from "../shared/summary-method.ts";
import { latestCompaction, withoutCarriedNotes } from "./continuity.ts";
import { requestMessages } from "./thinking.ts";
import { sessionClearedView } from "./clearing-view.ts";
import { withoutSupersededNotices } from "../shared/context-notices.ts";

/**
 * The messages as Octocode's own `context` handler (`register.ts`) sends them in every request: the results and `file`
 * payloads cleared on this branch as their placeholders, the same way each time, no thinking a compaction made stale (`thinking.ts`) and no
 * continuity message a later compaction carried on (`withoutCarriedNotes`). The cache-sharing summary request
 * (`shared-summary.ts`) builds its messages with the same function, so its prefix matches the last live request.
 */
export function requestView<T>(messages: T[], session: BranchSource, model: unknown): T[] {
	const latest = latestCompaction(session);
	return requestMessages(
		withoutCarriedNotes(
			withoutSupersededNotices(messages, latest?.id),
			latest?.id,
			summaryMethodOf(latest?.details) !== undefined,
		),
		model,
		sessionCleared(session),
		sessionClearedAt(session),
		sessionClearedView(session),
	);
}
