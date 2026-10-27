import type OpenAI from "openai";
import type {
	CacheRetention,
	ChatTemplateKwargValue,
	Message,
	Model,
	OpenAICompletionsCompat,
	ThinkingBudgetReduction,
	ThinkingTokenBudgetField,
} from "../../types.ts";
import { resolveCacheRetention, resolveInstructionCacheRetention } from "../../utils/cache-policy.ts";
import { splitSystemMessageAtBoundary } from "../../utils/instruction-split.ts";
import { resolveToolLoadingMode } from "../../utils/tool-loading.ts";
import {
	getDeclaredTools,
	getInitialSystemMessage,
	resolveTranscriptTools,
	type TranscriptContext,
} from "../../utils/transcript.ts";
import { createGrammarToolInputProperties } from "../constrained-sampling.ts";
import { clampOpenAIPromptCacheKey } from "../openai-prompt-cache.ts";
import {
	clampThinkingBudgetToAnswerRoom,
	resolveSamplingParams,
	thinkingBudgetForLevel,
	thinkingBudgetReduction,
} from "../simple-options.ts";
import { applyAnthropicCacheControl, getCompatCacheControl } from "./cache-control.ts";
import { getCompat } from "./compat.ts";
import { convertMessages } from "./messages.ts";
import { convertTools } from "./tools.ts";
import type {
	OpenAICompletionsOptions,
	ResolvedChatTemplateKwargValue,
	ResolvedOpenAICompletionsCompat,
} from "./types.ts";

/**
 * Check if conversation messages contain tool calls or tool results.
 * This is needed because Anthropic (via proxy) requires the tools param
 * to be present when messages include tool_calls or tool role messages.
 */
/**
 * `prompt_cache_retention` is an OpenAI field: send it to api.openai.com, or to an endpoint whose model compat
 * declares `supportsLongCacheRetention: true`. Other endpoints may reject the unknown field.
 */
function acceptsPromptCacheRetention(model: Model<"openai-completions">): boolean {
	return model.baseUrl.includes("api.openai.com") || model.compat?.supportsLongCacheRetention === true;
}

function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some((block) => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}

export function buildParams(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: OpenAICompletionsOptions,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
	cacheRetention: CacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env),
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		compat.supportsOpenAIGrammarTools,
	),
	onThinkingBudgetReduced?: (reduction: ThinkingBudgetReduction) => void,
) {
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		resolveToolLoadingMode("openai-completions", compat),
	);
	const messages = convertMessages(model, context, compat, {
		grammarToolInputProperties,
	});
	// Instructions and tools keep their own retention; a longer-lived breakpoint cannot follow a shorter one.
	const instructionRetention =
		cacheRetention === "none" ? "none" : (resolveInstructionCacheRetention(options) ?? cacheRetention);
	const historyRetention = instructionRetention === "short" && cacheRetention === "long" ? "short" : cacheRetention;
	const cacheControl = getCompatCacheControl(compat, historyRetention);
	const instructionCacheControl = getCompatCacheControl(compat, instructionRetention);

	const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: model.id,
		messages,
		stream: true,
		prompt_cache_key:
			(model.baseUrl.includes("api.openai.com") && cacheRetention !== "none") ||
			(cacheRetention === "long" && compat.supportsLongCacheRetention)
				? clampOpenAIPromptCacheKey(options?.sessionId)
				: undefined,
		prompt_cache_retention:
			cacheRetention === "long" && compat.supportsLongCacheRetention && acceptsPromptCacheRetention(model)
				? "24h"
				: undefined,
	};

	if (compat.supportsUsageInStreaming) {
		params.stream_options = { include_usage: true };
	}

	if (compat.supportsStore) {
		params.store = false;
	}

	if (options?.maxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			// Deprecated by OpenAI, but some OpenAI-compatible providers only accept max_tokens.
			(params as { max_tokens?: number }).max_tokens = options.maxTokens;
		} else {
			params.max_completion_tokens = options.maxTokens;
		}
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	if (transcriptTools.requestTools.length > 0) {
		params.tools = convertTools(transcriptTools.requestTools, compat);
		if (compat.zaiToolStream) {
			(params as any).tool_stream = true;
		}
	} else if (hasToolHistory(context.messages)) {
		// Anthropic (via LiteLLM/proxy) requires tools param when conversation has tool_calls/tool_results
		params.tools = [];
	}

	if (cacheControl || instructionCacheControl) {
		const initialSystemMessage = getInitialSystemMessage(context.messages);
		const splitSystem = initialSystemMessage
			? splitSystemMessageAtBoundary(initialSystemMessage, options?.instructionCacheBoundary)
			: undefined;
		applyAnthropicCacheControl(messages, params.tools, cacheControl, instructionCacheControl, splitSystem);
	}

	if (options?.toolChoice) {
		params.tool_choice = options.toolChoice;
	}

	if (compat.vllmPriority !== undefined) {
		(params as any).priority = compat.vllmPriority;
	}

	const thinkingTokenBudgetField = resolveThinkingTokenBudgetField(compat);
	const thinkingBudget = resolveClampedThinkingBudget(model, options, params);
	if (thinkingTokenBudgetField && options?.reasoningEffort && model.reasoning) {
		// Requested: the budget that fits the model's own output cap; a further cut came from the context-clamped ceiling.
		const reduction = thinkingBudgetReduction(
			clampThinkingBudgetToAnswerRoom(
				thinkingBudgetForLevel(options.reasoningEffort, options.thinkingBudgets),
				model.maxTokens,
			),
			thinkingBudget ?? 0,
		);
		if (reduction) onThinkingBudgetReduced?.(reduction);
	}

	if (compat.thinkingFormat === "zai" && model.reasoning) {
		const zaiParams = params as Omit<typeof params, "reasoning_effort"> & {
			thinking?: { type: "enabled" | "disabled"; clear_thinking?: boolean };
			reasoning_effort?: string;
		};
		zaiParams.thinking = options?.reasoningEffort ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			const mappedEffort = model.thinkingLevelMap?.[options.reasoningEffort];
			const effort = mappedEffort === undefined ? options.reasoningEffort : mappedEffort;
			if (typeof effort === "string") {
				zaiParams.reasoning_effort = effort;
			}
		}
	} else if (compat.thinkingFormat === "qwen" && model.reasoning) {
		(params as any).enable_thinking = !!options?.reasoningEffort;
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			const effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
			if (typeof effort === "string") {
				(params as any).reasoning_effort = effort;
			}
		}
	} else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
		(params as any).chat_template_kwargs = {
			enable_thinking: !!options?.reasoningEffort,
			preserve_thinking: true,
		};
	} else if (compat.thinkingFormat === "chat-template" && model.reasoning) {
		const chatTemplateKwargs = buildChatTemplateValues(model, options, compat.chatTemplateKwargs, thinkingBudget);
		if (chatTemplateKwargs) {
			(params as any).chat_template_kwargs = chatTemplateKwargs;
		}
	} else if (compat.thinkingFormat === "baseten" && model.reasoning) {
		const basetenParams = params as Omit<typeof params, "reasoning_effort"> & {
			chat_template_args?: Record<string, ResolvedChatTemplateKwargValue>;
			reasoning_effort?: string;
		};
		const chatTemplateArgs = buildChatTemplateValues(model, options, compat.chatTemplateArgs, thinkingBudget);
		if (chatTemplateArgs) {
			basetenParams.chat_template_args = chatTemplateArgs;
		}
		if (compat.supportsReasoningEffort) {
			const requestedEffort = options?.reasoningEffort;
			const mappedEffort = requestedEffort ? model.thinkingLevelMap?.[requestedEffort] : model.thinkingLevelMap?.off;
			const effort = mappedEffort === undefined ? requestedEffort : mappedEffort;
			if (typeof effort === "string") {
				basetenParams.reasoning_effort = effort;
			}
		}
	} else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
		if (options?.reasoningEffort) {
			(params as any).thinking = { type: "enabled" };
		} else if (model.thinkingLevelMap?.off !== null) {
			(params as any).thinking = { type: "disabled" };
		}
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			(params as any).reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		}
	} else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
		// OpenRouter normalizes reasoning across providers via a nested reasoning object.
		const openRouterParams = params as typeof params & { reasoning?: { effort?: string } };
		if (options?.reasoningEffort) {
			openRouterParams.reasoning = {
				effort: model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort,
			};
		} else if (model.thinkingLevelMap?.off !== null) {
			openRouterParams.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
		}
	} else if (compat.thinkingFormat === "ant-ling" && model.reasoning && options?.reasoningEffort) {
		const effort = model.thinkingLevelMap?.[options.reasoningEffort];
		if (typeof effort === "string") {
			(params as typeof params & { reasoning?: { effort: string } }).reasoning = { effort };
		}
	} else if (compat.thinkingFormat === "together" && model.reasoning) {
		const togetherParams = params as Omit<typeof params, "reasoning_effort"> & {
			reasoning?: { enabled: boolean };
			reasoning_effort?: string;
		};
		togetherParams.reasoning = { enabled: !!options?.reasoningEffort };
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			togetherParams.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		}
	} else if (compat.thinkingFormat === "string-thinking" && model.reasoning) {
		const stringThinkingParams = params as typeof params & { thinking?: string };
		if (options?.reasoningEffort) {
			stringThinkingParams.thinking = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		} else if (model.thinkingLevelMap?.off !== null) {
			stringThinkingParams.thinking = model.thinkingLevelMap?.off ?? "none";
		}
	} else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		// OpenAI-style reasoning_effort
		(params as any).reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
	} else if (!options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		const offValue = model.thinkingLevelMap?.off;
		if (typeof offValue === "string") {
			(params as any).reasoning_effort = offValue;
		}
	}

	// Cap reasoning with a top-level budget field. Independent of thinkingFormat: the
	// same server can serve zai, qwen or chat-template models. Reasoning and the answer
	// share max_tokens here, so an uncapped reasoning phase can consume the whole
	// response and leave no answer and no tool call.
	if (thinkingTokenBudgetField && thinkingBudget !== undefined) {
		Object.assign(params, { [thinkingTokenBudgetField]: thinkingBudget });
	}

	// OpenRouter provider routing preferences
	if (model.compat?.openRouterRouting) {
		(params as any).provider = model.compat.openRouterRouting;
	}

	// Vercel AI Gateway provider routing preferences
	if (model.compat?.vercelGatewayRouting) {
		const routing = model.compat.vercelGatewayRouting;
		if (routing.only || routing.order) {
			const gatewayOptions: Record<string, string[]> = {};
			if (routing.only) gatewayOptions.only = routing.only;
			if (routing.order) gatewayOptions.order = routing.order;
			(params as any).providerOptions = { gateway: gatewayOptions };
		}
	}

	// Last so model and request sampling parameters override named request fields.
	const samplingParams = resolveSamplingParams(model, options?.reasoningEffort ?? "off", options?.samplingParams);
	if (samplingParams) {
		Object.assign(params, samplingParams);
	}

	return params;
}

function resolveThinkingTokenBudgetField(
	compat: Pick<OpenAICompletionsCompat, "thinkingTokenBudgetField" | "supportsThinkingTokenBudget">,
): ThinkingTokenBudgetField | undefined {
	if (compat.thinkingTokenBudgetField) return compat.thinkingTokenBudgetField;
	if (compat.supportsThinkingTokenBudget) return "thinking_token_budget";
	return undefined;
}

function resolveClampedThinkingBudget(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	params: { max_tokens?: number | null; max_completion_tokens?: number | null },
): number | undefined {
	if (!options?.reasoningEffort || !model.reasoning) return undefined;
	const ceiling = params.max_tokens ?? params.max_completion_tokens ?? model.maxTokens;
	const budget = clampThinkingBudgetToAnswerRoom(
		thinkingBudgetForLevel(options.reasoningEffort, options.thinkingBudgets),
		ceiling,
	);
	return budget > 0 ? budget : undefined;
}

function buildChatTemplateValues(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	values: Record<string, ChatTemplateKwargValue>,
	thinkingBudget?: number,
): Record<string, ResolvedChatTemplateKwargValue> | undefined {
	const resolvedValues: Record<string, ResolvedChatTemplateKwargValue> = {};

	for (const [key, value] of Object.entries(values)) {
		const resolved = resolveChatTemplateKwargValue(model, options, value, thinkingBudget);
		if (resolved !== undefined) {
			resolvedValues[key] = resolved;
		}
	}

	return Object.keys(resolvedValues).length > 0 ? resolvedValues : undefined;
}

function resolveChatTemplateKwargValue(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	value: ChatTemplateKwargValue,
	thinkingBudget?: number,
): ResolvedChatTemplateKwargValue | undefined {
	if (typeof value !== "object" || value === null) {
		return value;
	}

	const reasoningEffort = options?.reasoningEffort;
	if (!reasoningEffort && value.omitWhenOff) {
		return undefined;
	}
	if (value.$var === "thinking.enabled") {
		return !!reasoningEffort;
	}
	if (value.$var === "thinking.budget") {
		return thinkingBudget;
	}

	const mappedValue = reasoningEffort ? model.thinkingLevelMap?.[reasoningEffort] : model.thinkingLevelMap?.off;
	return mappedValue === undefined ? reasoningEffort : typeof mappedValue === "string" ? mappedValue : undefined;
}
