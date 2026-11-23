import { bedrockRequestEffort } from "../../utils/bedrock-models.ts";
import { jsonSchema, tool, type ToolChoice, type ToolSet, type TextStreamPart } from "ai";
import { splitSystemMessageIntoBlocks } from "../../utils/instruction-split.ts";
import { resolveToolLoadingMode } from "../../utils/tool-loading.ts";
import { getInitialSystemMessage, resolveTranscriptTools, getDeclaredTools } from "../../utils/transcript.ts";
import {
	getJsonSchemaToolParameters,
	resolveJsonSchemaStrictSampling,
	createGrammarToolInputProperties,
} from "../constrained-sampling.ts";
import { sanitizeMoonshotToolParameters } from "../openai-completions/tool-schema-flavor.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import type { AssistantMessage, Model } from "../../types.ts";
import type { TranscriptContext } from "../../utils/transcript.ts";
import {
	applyAnthropicCacheControl,
	getCompatCacheControl,
	takeUnmarkedClaudeNotice,
} from "../openai-completions/cache-control.ts";
import { appendAssistantMessageDiagnostic } from "../../utils/diagnostics.ts";
import {
	resolveCacheRetention,
	resolveInstructionCacheRetention,
	resolvePromptCacheKey,
} from "../../utils/cache-policy.ts";
import { promptCacheKeyRule } from "../../models/capabilities.ts";
import { matchesHost } from "../../utils/provider-host.ts";
import { getCompat } from "../openai-completions/compat.ts";
import type { OpenAICompletionsOptions } from "../openai-completions/types.ts";
import { clampOpenAIPromptCacheKey } from "../openai-prompt-cache.ts";
import {
	clampThinkingBudgetToAnswerRoom,
	resolveSamplingParams,
	thinkingBudgetForLevel,
	thinkingBudgetReduction,
} from "../simple-options.ts";
import { augmentGrammarTools } from "./completions-grammar.ts";
import type { CompletionsState } from "./completions.ts";
import { completionsMessages } from "./completions-messages.ts";

export function completionsMapping(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options: OpenAICompletionsOptions = {},
) {
	const compat = getCompat(model);
	const messages = completionsMessages(model, context);
	const choice = options.toolChoice;
	const toolChoice: ToolChoice<ToolSet> | undefined =
		typeof choice === "string"
			? choice
			: choice?.type === "function"
				? { type: "tool", toolName: choice.function.name }
				: undefined;
	const tools: ToolSet = Object.fromEntries(
		resolveTranscriptTools(context.messages, resolveToolLoadingMode("openai-completions", compat)).requestTools.map(
			(definition) => {
				const strict = resolveJsonSchemaStrictSampling(definition, compat.supportsStrictMode);
				const schema = getJsonSchemaToolParameters(definition, strict);
				return [
					definition.name,
					tool({
						description: definition.description,
						inputSchema: jsonSchema(
							compat.toolSchemaFlavor === "moonshot" ? sanitizeMoonshotToolParameters(schema) : schema,
						),
						...(compat.supportsStrictMode ? { strict: strict ?? false } : {}),
					}),
				];
			},
		),
	);
	const completionsState: CompletionsState = {
		emptyToolInputs: new Set(),
		grammarToolInputProperties: createGrammarToolInputProperties(
			getDeclaredTools(context.messages),
			compat.supportsOpenAIGrammarTools,
		),
	};
	const onPart = (
		part: TextStreamPart<ToolSet>,
		output: AssistantMessage,
		stream: AssistantMessageEventStream,
	): boolean => {
		if (part.type === "start" && options.reasoningEffort && model.reasoning && compat.thinkingTokenBudgetField) {
			const requested = clampThinkingBudgetToAnswerRoom(
				thinkingBudgetForLevel(options.reasoningEffort, options.thinkingBudgets),
				model.maxTokens,
			);
			const sent = clampThinkingBudgetToAnswerRoom(
				thinkingBudgetForLevel(options.reasoningEffort, options.thinkingBudgets),
				options.maxTokens ?? model.maxTokens,
			);
			output.thinkingBudget = thinkingBudgetReduction(requested, sent);
		}
		if (part.type === "finish") {
			const notice = takeUnmarkedClaudeNotice(
				model,
				compat,
				resolveCacheRetention(options.cacheRetention, options.env),
			);
			if (notice) appendAssistantMessageDiagnostic(output, notice);
		}
		if (
			(part.type === "finish" || part.type === "text-start") &&
			completionsState.details?.length &&
			!output.content.some((block) => block.type === "thinking")
		) {
			const contentIndex = output.content.length;
			output.content.push({
				type: "thinking",
				thinking: "",
				thinkingSignature: JSON.stringify(completionsState.details),
			});
			stream.push({ type: "thinking_start", contentIndex, partial: output });
			stream.push({ type: "thinking_end", contentIndex, content: "", partial: output });
		}
		return false;
	};
	return {
		messages,
		completionsState,
		tools,
		toolChoice,
		onPart,
		// No raw chunks: `normalizeCompletionsResponse` already reads every SSE event (reasoning_details included), and a
		// raw part per chunk doubles the parts the SDK's stream pipeline carries.
		augmentRequest: (body: Record<string, unknown>) => {
			completionsState.longCacheWrites = augmentCompletionsRequest(model, options, body, context);
		},
		providerOptions: { octocode: { reasoningEffort: options.reasoningEffort } },
	};
}

/**
 * Fields not represented by openai-compatible's provider options are added to its serialized request. Returns whether
 * every cache marker it placed was a 1h marker (`applyAnthropicCacheControl`).
 */
function augmentCompletionsRequest(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions,
	body: Record<string, unknown>,
	context?: TranscriptContext,
): boolean {
	const compat = getCompat(model);
	if (context) augmentGrammarTools(model, context, body);
	if (options.toolChoice) body.tool_choice = options.toolChoice;
	if (Array.isArray(body.messages))
		for (const message of body.messages)
			if (message.role === "system" && message.tools && message.content === "") delete message.content;
	const retention = resolveCacheRetention(options.cacheRetention, options.env);
	const instructionRetention =
		retention === "none"
			? options.keepInstructionCache
				? (options.instructionCacheRetention ?? "none")
				: "none"
			: (resolveInstructionCacheRetention(options) ?? retention);
	const longCacheWrites =
		Array.isArray(body.messages) &&
		applyAnthropicCacheControl(
			body.messages as Parameters<typeof applyAnthropicCacheControl>[0],
			body.tools as Parameters<typeof applyAnthropicCacheControl>[1],
			getCompatCacheControl(compat, instructionRetention === "short" && retention === "long" ? "short" : retention),
			getCompatCacheControl(compat, instructionRetention),
			context && getInitialSystemMessage(context.messages)
				? splitSystemMessageIntoBlocks(
						getInitialSystemMessage(context.messages)!,
						options.instructionCacheBoundary,
						options.instructionVolatileBoundary,
					)
				: undefined,
			options.toolCacheBoundary,
		);
	const rule = promptCacheKeyRule(model);
	if (retention !== "none" && (rule === "cached" || (rule === "long" && retention === "long")))
		body.prompt_cache_key = clampOpenAIPromptCacheKey(resolvePromptCacheKey(options));
	if (
		retention === "long" &&
		compat.supportsLongCacheRetention &&
		!model.compat?.supportsExplicitPromptCacheMode &&
		(matchesHost(model.baseUrl, "api.openai.com") || model.compat?.supportsLongCacheRetention)
	)
		body.prompt_cache_retention = "24h";
	if (compat.supportsStore) body.store = false;
	if (!compat.supportsUsageInStreaming) delete body.stream_options;
	if (compat.maxTokensField === "max_tokens" && body.max_completion_tokens !== undefined) {
		body.max_tokens = body.max_completion_tokens;
		delete body.max_completion_tokens;
	}
	if (compat.vllmPriority !== undefined) body.priority = compat.vllmPriority;
	if (compat.zaiToolStream && Array.isArray(body.tools) && body.tools.length) body.tool_stream = true;
	const enabled = !!options.reasoningEffort;
	const effort =
		bedrockRequestEffort(model, options.reasoningEffort) ??
		(enabled
			? (model.thinkingLevelMap?.[options.reasoningEffort!] ?? options.reasoningEffort)
			: model.thinkingLevelMap?.off === null
				? undefined
				: (model.thinkingLevelMap?.off ?? (matchesHost(model.baseUrl, "api.openai.com") ? "none" : undefined)));
	if (model.reasoning) {
		delete body.reasoning_effort;
		if (compat.supportsReasoningEffort && typeof effort === "string") body.reasoning_effort = effort;
		switch (compat.thinkingFormat) {
			case "baseten":
			case "chat-template":
			case "openai":
				break;
			case "zai":
				if (!enabled) delete body.reasoning_effort;
				body.thinking = enabled ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
				break;
			case "deepseek":
				if (enabled || model.thinkingLevelMap?.off !== null) body.thinking = { type: enabled ? "enabled" : "disabled" };
				break;
			case "qwen":
				body.enable_thinking = enabled;
				break;
			case "qwen-chat-template":
				body.chat_template_kwargs = { enable_thinking: enabled, preserve_thinking: true };
				delete body.reasoning_effort;
				break;
			case "openrouter":
				if (enabled || model.thinkingLevelMap?.off !== null) body.reasoning = { effort: effort ?? "none" };
				delete body.reasoning_effort;
				break;
			case "ant-ling":
				if (enabled && typeof model.thinkingLevelMap?.[options.reasoningEffort!] === "string")
					body.reasoning = { effort: model.thinkingLevelMap[options.reasoningEffort!] };
				delete body.reasoning_effort;
				break;
			case "together":
				body.reasoning = { enabled };
				break;
			case "string-thinking":
				if (enabled || model.thinkingLevelMap?.off !== null) body.thinking = effort ?? "none";
				delete body.reasoning_effort;
				break;
		}
		const budget = enabled
			? clampThinkingBudgetToAnswerRoom(
					thinkingBudgetForLevel(options.reasoningEffort!, options.thinkingBudgets),
					options.maxTokens ?? model.maxTokens,
				)
			: undefined;
		const budgetField = compat.thinkingTokenBudgetField;
		if (budgetField && budget !== undefined && budget > 0) body[budgetField] = budget;
		const template =
			compat.thinkingFormat === "baseten"
				? compat.chatTemplateArgs
				: compat.thinkingFormat === "chat-template"
					? compat.chatTemplateKwargs
					: undefined;
		if (template) {
			const values: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(template)) {
				if (typeof value !== "object" || value === null) values[key] = value;
				else if (enabled || !value.omitWhenOff)
					values[key] =
						value.$var === "thinking.enabled" ? enabled : value.$var === "thinking.budget" ? budget : effort;
			}
			if (Object.keys(values).length)
				body[compat.thinkingFormat === "baseten" ? "chat_template_args" : "chat_template_kwargs"] = values;
		}
	}
	if (model.compat?.openRouterRouting) body.provider = model.compat.openRouterRouting;
	if (model.compat?.vercelGatewayRouting) body.providerOptions = { gateway: model.compat.vercelGatewayRouting };
	Object.assign(body, resolveSamplingParams(model, options.reasoningEffort ?? "off", options.samplingParams));
	return longCacheWrites;
}
