import type { SimpleStreamOptions, StreamFunction } from "../types.ts";
import { streamSdk } from "./ai-sdk/stream.ts";
import { bedrockSdkMapping } from "./ai-sdk/bedrock-map.ts";
import { lazyApi } from "./lazy.ts";
import {
	adjustMaxTokensForThinking,
	buildBaseOptions,
	requestedReasoningEffort,
	clampMaxTokensToContext,
	clampReasoning,
	thinkingBudgetForLevel,
	thinkingBudgetReduction,
} from "./simple-options.ts";
import { fitClaudeThinkingBudget } from "./anthropic-messages/thinking-budget.ts";
import { isAnthropicClaudeModel, supportsAdaptiveThinking } from "./bedrock-converse-stream/model-match.ts";
import type { BedrockOptions } from "./bedrock-converse-stream/types.ts";
export type { BedrockOptions, BedrockThinkingDisplay } from "./bedrock-converse-stream/types.ts";

export const stream: StreamFunction<"bedrock-converse-stream", BedrockOptions> = (model, context, options = {}) =>
	lazyApi(async () => ({
		stream: () => streamSdk(model, context, options, bedrockSdkMapping(model, context, options)),
		streamSimple,
	})).stream(model, context, options);

export const streamSimple: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions> = (
	model,
	context,
	options,
) => {
	const base = {
		...buildBaseOptions(model, context, options, undefined),
		toolChoice: options?.toolChoice,
	} satisfies BedrockOptions;
	if (!options?.reasoning) return stream(model, context, { ...base, reasoning: undefined });
	if (!isAnthropicClaudeModel(model))
		return stream(model, context, { ...base, reasoning: requestedReasoningEffort(model, options) });
	if (supportsAdaptiveThinking(model.id, model.name))
		return stream(model, context, { ...base, reasoning: options.reasoning, thinkingBudgets: options.thinkingBudgets });
	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);
	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
	const thinkingBudget = fitClaudeThinkingBudget(adjusted.thinkingBudget, maxTokens);
	const reduction = thinkingBudgetReduction(
		fitClaudeThinkingBudget(thinkingBudgetForLevel(options.reasoning, options.thinkingBudgets), model.maxTokens),
		thinkingBudget,
	);
	return stream(model, context, {
		...base,
		maxTokens,
		reasoning: thinkingBudget === 0 ? undefined : options.reasoning,
		thinkingBudgetReduction: reduction,
		thinkingBudgets: { ...options.thinkingBudgets, [clampReasoning(options.reasoning)!]: thinkingBudget },
	});
};
