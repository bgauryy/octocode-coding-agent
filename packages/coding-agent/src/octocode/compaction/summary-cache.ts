import type { Api, Model } from "@octocodeai/octocode-ai";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import type { CompactionPreparation } from "../../core/compaction/index.ts";

/** Reuse a paid summary only for the same content and output budget, including context edits with unchanged token estimates. */
export function paidSummaryKey(
	model: Model<Api>,
	preparation: CompactionPreparation,
	instructions: string | undefined,
	thinking: string,
	forcedSystemPrompt?: string,
): string {
	return sha256(
		JSON.stringify([
			model.provider,
			model.id,
			model.api,
			model.contextWindow,
			model.maxTokens,
			preparation.firstKeptEntryId,
			preparation.tokensBefore,
			preparation.isSplitTurn,
			preparation.messagesToSummarize,
			preparation.turnPrefixMessages,
			preparation.previousSummary ?? null,
			[...preparation.fileOps.read].sort(),
			[...preparation.fileOps.edited].sort(),
			[...preparation.fileOps.written].sort(),
			preparation.settings.reserveTokens,
			instructions ?? null,
			thinking,
			forcedSystemPrompt,
		]),
	);
}
