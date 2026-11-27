import type { Model } from "../../types.ts";
import { isOpenRouterModel, markersApplyTo, profileCacheFacts, profileQuirks } from "../../utils/provider-profile.ts";
import type { ResolvedOpenAICompletionsCompat } from "./types.ts";

/**
 * Kimi and Moonshot model ids (OpenRouter `moonshotai/kimi-*` slugs, relayed ids like `kimi-k3`) reach Moonshot's
 * upstream inference and its strict tool-schema validation even when the provider in front of them is a gateway,
 * so their tool parameters take the moonshot flavor regardless of provider or baseUrl. Only the schema flavor is
 * affected: the gateway's own request format still wins for everything else.
 */
function isMoonshotModelId(modelId: string): boolean {
	return /(?:^|[/\-_.])kimi/i.test(modelId) || /(?:^|[/\-_.])moonshot/i.test(modelId);
}

/**
 * Auto-detect compatibility settings from provider name and baseUrl.
 * Used as the base when model.compat is not set; explicit model.compat
 * entries override these detected values.
 */
function detectCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const provider = model.provider;

	// The profile table decides by declared profile, else by provider id or host (domain match, never substring: a proxy
	// URL that only names a provider in its path keeps the generic request format).
	const quirks = profileQuirks(model);
	const cache = profileCacheFacts(model, "host");
	const isOpenRouter = isOpenRouterModel(model);
	const isNonStandard = quirks.nonStandard === true;

	const isOpenRouterDeveloperRoleModel =
		quirks.developerRoleModelPrefixes?.some((prefix) => model.id.startsWith(prefix)) ?? false;
	// The `developer` role is opt-in: a host that does not know it can drop the instructions without an error, so an
	// unlisted host (a proxy, a local server) gets `system`. The profiles that list it are those whose built-in models
	// carry no `supportsDeveloperRole` flag and accept the role; any model can still set the flag in its compat.
	const isDeveloperRoleHost = quirks.developerRole === true;
	// Other explicit-marker models (OpenRouter's Alibaba ids) declare `cacheControlFormat` in their catalog compat.
	const cacheControlFormat = markersApplyTo(cache, model.id) ? "anthropic" : undefined;

	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (isDeveloperRoleHost && !isNonStandard && !isOpenRouter),
		supportsReasoningEffort: quirks.noReasoningEffort !== true,
		supportsUsageInStreaming: true,
		supportsFinishReason: true,
		maxTokensField: quirks.maxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: quirks.reasoningContentOnAssistant === true,
		thinkingFormat: quirks.thinkingFormat ?? "openai",
		openRouterRouting: {},
		vercelGatewayRouting: {},
		chatTemplateKwargs: {},
		chatTemplateArgs: {},
		zaiToolStream: false,
		thinkingTokenBudgetField: undefined,
		// OpenAI compatibility alone does not imply strict JSON-schema tool support.
		supportsStrictMode: false,
		supportsOpenAIGrammarTools: false,
		supportsMidConvoSystemMessages: false,
		supportsMidConvoToolAdditions: false,
		cacheControlFormat,
		sendSessionAffinityHeaders: cache.sessionAffinity !== undefined,
		sessionAffinityFormat: cache.sessionAffinity ?? "openai",
		// OpenCode Go streams `reasoning` but expects it back as `reasoning_content`.
		reasoningReplayField: provider === "opencode-go" ? "reasoning_content" : undefined,
		toolCallIdMaxLength: quirks.toolCallIdMaxLength,
		// Without markers the long tier is `prompt_cache_retention: "24h"`, which api.openai.com takes only for the models
		// OpenAI lists (the catalog sets the flag for them); Chat Completions has no 12h tier for GPT-5.6 and later.
		supportsLongCacheRetention:
			cache.noLongRetention === "always" ||
			(cache.noLongRetention === "unlessMarkers" && cacheControlFormat !== "anthropic")
				? false
				: true,
		toolSchemaFlavor: quirks.moonshotToolSchema || isMoonshotModelId(model.id) ? "moonshot" : undefined,
	};
}

/**
 * Get resolved compatibility settings for a model.
 * Auto-detects from provider/URL then overrides with explicit model.compat.
 */
export function getCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const detected = detectCompat(model);
	if (!model.compat) return detected;

	return {
		supportsStore: model.compat.supportsStore ?? detected.supportsStore,
		supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
		supportsFinishReason: model.compat.supportsFinishReason ?? detected.supportsFinishReason,
		maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult:
			model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		requiresReasoningContentOnAssistantMessages:
			model.compat.requiresReasoningContentOnAssistantMessages ?? detected.requiresReasoningContentOnAssistantMessages,
		thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
		openRouterRouting: model.compat.openRouterRouting ?? {},
		openRouterAutoRouter: model.compat.openRouterAutoRouter,
		vercelGatewayRouting: model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
		chatTemplateKwargs: model.compat.chatTemplateKwargs ?? detected.chatTemplateKwargs,
		chatTemplateArgs: model.compat.chatTemplateArgs ?? detected.chatTemplateArgs,
		zaiToolStream: model.compat.zaiToolStream ?? detected.zaiToolStream,
		thinkingTokenBudgetField: model.compat.thinkingTokenBudgetField ?? detected.thinkingTokenBudgetField,
		supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
		supportsOpenAIGrammarTools: model.compat.supportsOpenAIGrammarTools ?? detected.supportsOpenAIGrammarTools,
		supportsMidConvoSystemMessages:
			model.compat.supportsMidConvoSystemMessages ?? detected.supportsMidConvoSystemMessages,
		supportsMidConvoToolAdditions: model.compat.supportsMidConvoToolAdditions ?? detected.supportsMidConvoToolAdditions,
		cacheControlFormat: model.compat.cacheControlFormat ?? detected.cacheControlFormat,
		sendSessionAffinityHeaders: model.compat.sendSessionAffinityHeaders ?? detected.sendSessionAffinityHeaders,
		sessionAffinityFormat: model.compat.sessionAffinityFormat ?? detected.sessionAffinityFormat,
		supportsLongCacheRetention: model.compat.supportsLongCacheRetention ?? detected.supportsLongCacheRetention,
		vllmPriority: model.compat.vllmPriority,
		// "standard" is an explicit opt-out: it is truthy, so it overrides any auto-detected "moonshot".
		toolSchemaFlavor: model.compat.toolSchemaFlavor ?? detected.toolSchemaFlavor,
		reasoningReplayField: detected.reasoningReplayField,
		toolCallIdMaxLength: detected.toolCallIdMaxLength,
	};
}
