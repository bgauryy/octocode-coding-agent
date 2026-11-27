import type { ChatCompletionToolChoiceOption } from "../ai-sdk/openai-wire-types.ts";
import type { OpenAICompletionsCompat, StreamOptions, ThinkingBudgets } from "../../types.ts";

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: ChatCompletionToolChoiceOption;
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Token budgets per thinking level. Used when `compat.thinkingTokenBudgetField` is set, or by `{ "$var": "thinking.budget" }`. */
	thinkingBudgets?: ThinkingBudgets;
}

export interface OpenAICompatCacheControl {
	type: "ephemeral";
	ttl?: string;
}

export type ResolvedOpenAICompletionsCompat = Omit<
	Required<OpenAICompletionsCompat>,
	| "cacheControlFormat"
	| "openRouterAutoRouter"
	| "thinkingTokenBudgetField"
	| "supportsMidConvoSystemMessages"
	| "supportsMidConvoToolAdditions"
	| "vllmPriority"
	| "toolSchemaFlavor"
	| "supportsTemperature"
	| "supportsExplicitPromptCacheMode"
> & {
	supportsTemperature?: OpenAICompletionsCompat["supportsTemperature"];
	openRouterAutoRouter?: OpenAICompletionsCompat["openRouterAutoRouter"];
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	supportsExplicitPromptCacheMode?: OpenAICompletionsCompat["supportsExplicitPromptCacheMode"];
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
	supportsMidConvoSystemMessages?: OpenAICompletionsCompat["supportsMidConvoSystemMessages"];
	supportsMidConvoToolAdditions?: OpenAICompletionsCompat["supportsMidConvoToolAdditions"];
	vllmPriority?: OpenAICompletionsCompat["vllmPriority"];
	toolSchemaFlavor?: OpenAICompletionsCompat["toolSchemaFlavor"];
	/** Longest plain tool-call id the provider accepts; longer ids are cut. Unset when it imposes no limit. */
	toolCallIdMaxLength?: number;
	/** The field streamed `reasoning` deltas are recorded and replayed under, when the provider expects another. */
	reasoningReplayField?: "reasoning_content";
};
