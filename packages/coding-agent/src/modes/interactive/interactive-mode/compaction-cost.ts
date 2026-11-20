import type { Usage } from "@octocodeai/octocode-ai";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import type { SessionEntry } from "../../../core/session-manager.ts";
import { combineUsage } from "../../../core/usage-totals.ts";

/**
 * What a compaction's summary cost, for the cost line under its message. A summary written before attempts were recorded
 * carries its usage on the entry; the built-in and Octocode summaries record each request as a `compaction_attempt` usage
 * entry instead and name them in `details.attemptIds` (`core/compaction/outcome.ts`), so their sum is the cost. Undefined
 * when neither is there.
 */
export function compactionUsage(
	entry: Pick<Extract<SessionEntry, { type: "compaction" | "branch_summary" }>, "usage" | "details">,
	getEntry: (id: string) => SessionEntry | undefined,
): Usage | undefined {
	if (entry.usage) return entry.usage;
	const ids = asRecord(entry.details).attemptIds;
	if (!Array.isArray(ids)) return undefined;
	let total: Usage | undefined;
	for (const id of ids) {
		const attempt = typeof id === "string" ? getEntry(id) : undefined;
		if (attempt?.type !== "usage") continue;
		total = total ? combineUsage(total, attempt.usage) : attempt.usage;
	}
	return total;
}
