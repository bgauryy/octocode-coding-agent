import type OpenAI from "openai";
import type { OpenAICompletionsCompat, StreamOptions, ThinkingBudgets } from "../../types.ts";

export interface OpenAICompletionsOptions extends StreamOptions {
	toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Token budgets per thinking level. Used when `compat.thinkingTokenBudgetField` or `compat.supportsThinkingTokenBudget` is set, or by `{ "$var": "thinking.budget" }`. */
	thinkingBudgets?: ThinkingBudgets;
}

export interface ConvertCompletionsMessagesOptions {
	grammarToolInputProperties?: ReadonlyMap<string, string>;
}

export interface OpenAICompatCacheControl {
	type: "ephemeral";
	ttl?: string;
}

export type ResolvedOpenAICompletionsCompat = Omit<
	Required<OpenAICompletionsCompat>,
	| "cacheControlFormat"
	| "supportsThinkingTokenBudget"
	| "thinkingTokenBudgetField"
	| "supportsMidConvoSystemMessages"
	| "supportsMidConvoToolAdditions"
	| "vllmPriority"
	| "toolSchemaFlavor"
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	supportsThinkingTokenBudget?: OpenAICompletionsCompat["supportsThinkingTokenBudget"];
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

/**
 * Fields OpenAI-compatible vendors accept beyond the OpenAI SDK's typed request, so the request builder writes them
 * with their real types instead of casting. `reasoning_effort` is a plain string because vendors define their own levels.
 */
export interface VendorRequestFields {
	tool_stream?: boolean;
	priority?: number;
	enable_thinking?: boolean;
	chat_template_kwargs?: Record<string, ResolvedChatTemplateKwargValue>;
	chat_template_args?: Record<string, ResolvedChatTemplateKwargValue>;
	/** Z.ai/DeepSeek take an object, Together-style `string-thinking` providers a level name. */
	thinking?: { type: "enabled" | "disabled"; clear_thinking?: boolean } | string;
	reasoning?: { effort?: string; enabled?: boolean };
	reasoning_effort?: string;
	/** OpenRouter provider routing preferences; the field is named `provider` in OpenRouter's request body. */
	provider?: NonNullable<OpenAICompletionsCompat["openRouterRouting"]>;
	providerOptions?: { gateway: Record<string, string[]> };
}

export type CompletionsRequestParams = Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, "reasoning_effort"> &
	VendorRequestFields;

export type ResolvedChatTemplateKwargValue = string | number | boolean | null;
