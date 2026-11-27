import type { SessionEntry } from "../session-manager.ts";
import { buildPathProjection } from "../session-manager/context.ts";
import { recentMessageTokens } from "./cut-point.ts";

/**
 * Why a manual compaction has nothing to summarize, in words that match the cause, for the error and a short notice.
 * The tokens are counted as the cut point counts them (`recentMessageTokens`): the conversation since the newest
 * summary, without the system prompt or its updates. Compaction keeps the newest `keepRecentTokens` of it and summarizes
 * the complete turns before; nothing is left when that kept part reaches back to the first turn.
 */
export function explainNothingToCompact(
	pathEntries: SessionEntry[],
	keepRecentTokens: number,
): { message: string; notice: string } {
	const entries = buildPathProjection(pathEntries).entries;
	const summary = entries.findIndex((entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0);
	const counted = entries.slice(summary + 1).reduce((total, entry) => total + recentMessageTokens(entry), 0);
	const since = summary >= 0 ? " since the last summary" : "";
	const budget = `${keepRecentTokens.toLocaleString("en-US")}-token budget compaction keeps as recent messages`;
	const detail =
		counted === 0
			? `the session has no messages ${summary >= 0 ? "since the last summary" : "yet"}`
			: counted < keepRecentTokens
				? `the conversation${since} is about ${counted.toLocaleString("en-US")} tokens, within the ${budget} (the system prompt and tools do not count toward it)`
				: `the ${budget} reaches back to the first turn${since}, so no complete earlier turn is left to summarize`;
	return { message: `Nothing to compact: ${detail}`, notice: `Nothing to compact yet: ${detail}` };
}
