import type { Api, AssistantMessage, Model, Usage } from "../types.ts";
import { nonZeroOr } from "./non-zero.ts";

/** Zeroed usage for an assistant message that has not received any token counts yet. */
export function createEmptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Token counts a provider reported for one response; absent counts are zero. */
interface UsageCounts {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** Subset of `output` the provider reports as reasoning tokens; omitted when the provider has no such breakdown. */
	reasoning?: number;
	/** Total the provider reported. Preferred over the component sum when it is larger. */
	totalTokens?: number;
}

/**
 * Total tokens of a usage: input, output and cache reads and writes (reasoning is already part of output), or the
 * provider's own total when it is larger. A provider total below the components left something out (Bedrock documents
 * its total only as input plus output), and compaction reads this total as the context size, so it never undercounts.
 */
export function sumUsageTokens(
	usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">,
	providerTotal?: number,
): number {
	const sum = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return Math.max(sum, nonZeroOr(sum, providerTotal));
}

/** Usage with zero cost for reported counts; price it with `calculateCost`. */
export function createUsage(counts: UsageCounts): Usage {
	const usage: Usage = {
		...createEmptyUsage(),
		input: counts.input,
		output: counts.output,
		cacheRead: counts.cacheRead ?? 0,
		cacheWrite: counts.cacheWrite ?? 0,
	};
	if (counts.reasoning !== undefined) usage.reasoning = counts.reasoning;
	usage.totalTokens = sumUsageTokens(usage, counts.totalTokens);
	return usage;
}

/**
 * Empty assistant message a provider stream fills in while it runs. `api` defaults to
 * the model's API; pass it when the adapter reports a fixed API name.
 */
export function createPendingAssistantMessage(model: Model<Api>, api: Api = model.api): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
}
