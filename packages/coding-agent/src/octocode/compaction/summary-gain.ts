import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import type { CompactionPreparation } from "../../core/compaction/index.ts";
import { estimateTokens } from "../../core/compaction/tokens.ts";
import { renderInstruction } from "../../core/prompt-template.ts";

/**
 * Whether a compaction frees context. After it, the context holds the new summary and the kept messages; before it,
 * the earlier summary, the summarized messages and the same kept messages. A summary at least as large as the earlier
 * summary and the summarized messages together frees nothing (the kept tail is most of the context), and committing it
 * would only bring the next compaction sooner: the reason it is not committed, else undefined.
 */
export function noGainReason(
	preparation: Pick<CompactionPreparation, "messagesToSummarize" | "turnPrefixMessages" | "previousSummary">,
	summary: string,
): string | undefined {
	const summarized = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages].reduce(
		(sum, message) => sum + estimateTokens(message),
		0,
	);
	const replaced = summarized + Math.ceil((preparation.previousSummary?.length ?? 0) / CHARS_PER_TOKEN);
	const written = Math.ceil(summary.length / CHARS_PER_TOKEN);
	return written < replaced
		? undefined
		: renderInstruction("notices/compaction/no-gain.md", { summary: written, replaced });
}
