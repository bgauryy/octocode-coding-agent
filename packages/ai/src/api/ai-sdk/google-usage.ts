import type { Usage } from "../../types.ts";
import { createUsage } from "../../utils/assistant-message.ts";

export interface GoogleUsageMetadata {
	promptTokenCount?: number;
	cachedContentTokenCount?: number;
	thoughtsTokenCount?: number;
	candidatesTokenCount?: number;
	toolUsePromptTokenCount?: number;
	totalTokenCount?: number;
}

/** Normalize Google's inclusive prompt count into disjoint billing buckets. */
export function normalizeGoogleUsage(metadata: GoogleUsageMetadata): Usage {
	const count = (value: number | undefined): number =>
		typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
	const reportedCache = count(metadata.cachedContentTokenCount);
	const prompt = metadata.promptTokenCount === undefined ? reportedCache : count(metadata.promptTokenCount);
	const cacheRead = Math.min(prompt, reportedCache);
	const reasoning = count(metadata.thoughtsTokenCount);
	const output = count(metadata.candidatesTokenCount) + reasoning;
	const toolUse = count(metadata.toolUsePromptTokenCount);
	return createUsage({
		input: prompt - cacheRead + toolUse,
		output,
		cacheRead,
		reasoning,
		totalTokens: count(metadata.totalTokenCount),
	});
}
