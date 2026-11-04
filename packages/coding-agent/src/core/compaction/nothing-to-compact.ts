import { buildSessionProjection, type SessionEntry } from "../session-manager.ts";
import { estimateTokens } from "./tokens.ts";

/** Why a manual compaction has nothing to summarize, in words that match the cause, for the error and a short notice. */
export function explainNothingToCompact(
	pathEntries: SessionEntry[],
	keepRecentTokens: number,
): { message: string; notice: string } {
	// The system prompt and tool declarations are not history; neither is an earlier summary.
	const history = buildSessionProjection(pathEntries).messages.reduce(
		(sum, message) =>
			message.role === "system" || message.role === "compactionSummary" ? sum : sum + estimateTokens(message),
		0,
	);
	if (history < keepRecentTokens) {
		const detail = `the recent history is about ${history.toLocaleString("en-US")} tokens, below the ${keepRecentTokens.toLocaleString("en-US")}-token budget that compaction keeps as recent messages (the system prompt and tools are not history)`;
		return { message: `Nothing to compact: ${detail}`, notice: `Nothing to compact yet: ${detail}` };
	}
	const detail = "no complete earlier turn lies before the recent messages that compaction keeps";
	return { message: `Nothing to compact: ${detail}`, notice: `Nothing to compact yet: ${detail}` };
}
