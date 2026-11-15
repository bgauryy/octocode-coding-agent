import type { Model } from "../../types.ts";
import { isOpenRouterModel, matchesDomain, matchesHost } from "../../utils/provider-host.ts";
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
	const baseUrl = model.baseUrl;

	// Hosts match by domain (host or subdomain), never by substring: a proxy URL that only names a provider in its path
	// keeps the generic request format.
	const isZai =
		provider === "zai" || provider === "zai-coding-cn" || matchesDomain(baseUrl, "api.z.ai", "open.bigmodel.cn");
	const isTogether = provider === "together" || matchesDomain(baseUrl, "api.together.ai", "api.together.xyz");
	const isMoonshot =
		provider === "moonshotai" ||
		provider === "moonshotai-cn" ||
		provider === "kimi-coding" ||
		matchesDomain(baseUrl, "api.moonshot.ai", "api.moonshot.cn", "api.kimi.com");
	const isOpenRouter = isOpenRouterModel(model);
	const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || matchesDomain(baseUrl, "api.cloudflare.com");
	const isCloudflareAiGateway =
		provider === "cloudflare-ai-gateway" || matchesDomain(baseUrl, "gateway.ai.cloudflare.com");
	const isNvidia = provider === "nvidia" || matchesDomain(baseUrl, "integrate.api.nvidia.com");
	const isAntLing = provider === "ant-ling" || matchesDomain(baseUrl, "api.ant-ling.com");
	const isCerebras = provider === "cerebras" || matchesDomain(baseUrl, "cerebras.ai");
	const isDeepSeek = provider === "deepseek" || matchesDomain(baseUrl, "deepseek.com");
	const isGrok = provider === "xai" || matchesDomain(baseUrl, "api.x.ai");
	const isChutes = matchesDomain(baseUrl, "chutes.ai");
	const isOpencode = provider === "opencode" || matchesDomain(baseUrl, "opencode.ai");

	const isNonStandard =
		isNvidia ||
		isCerebras ||
		isGrok ||
		isTogether ||
		isChutes ||
		isDeepSeek ||
		isZai ||
		isMoonshot ||
		isOpencode ||
		isCloudflareWorkersAI ||
		isCloudflareAiGateway ||
		isAntLing;

	const useMaxTokens =
		isChutes || isDeepSeek || isMoonshot || isCloudflareAiGateway || isTogether || isNvidia || isAntLing || isZai;

	const isOpenRouterDeveloperRoleModel =
		isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
	// The `developer` role is opt-in: a host that does not know it can drop the instructions without an error, so an
	// unlisted host (a proxy, a local server) gets `system`. Listed here are the hosts whose built-in models carry no
	// `supportsDeveloperRole` flag and accept the role; any model can still set the flag in its compat.
	const isDeveloperRoleHost =
		provider === "openai" ||
		matchesHost(baseUrl, "api.openai.com") ||
		provider === "groq" ||
		matchesHost(baseUrl, "api.groq.com") ||
		provider.startsWith("xiaomi") ||
		matchesDomain(baseUrl, "xiaomimimo.com");
	const isOpenRouterAnthropic = provider === "openrouter" && /^~?anthropic\//.test(model.id);
	// Other explicit-marker models (OpenRouter's Alibaba ids) declare `cacheControlFormat` in their catalog compat.
	const cacheControlFormat = isOpenRouterAnthropic ? "anthropic" : undefined;

	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (isDeveloperRoleHost && !isNonStandard && !isOpenRouter),
		supportsReasoningEffort:
			!isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
		supportsUsageInStreaming: true,
		supportsFinishReason: true,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: isDeepSeek,
		thinkingFormat: isDeepSeek
			? "deepseek"
			: isZai
				? "zai"
				: isTogether
					? "together"
					: isAntLing
						? "ant-ling"
						: isOpenRouter
							? "openrouter"
							: "openai",
		openRouterRouting: {},
		vercelGatewayRouting: {},
		chatTemplateKwargs: {},
		chatTemplateArgs: {},
		zaiToolStream: false,
		supportsThinkingTokenBudget: false,
		thinkingTokenBudgetField: undefined,
		// OpenAI compatibility alone does not imply strict JSON-schema tool support.
		supportsStrictMode: false,
		supportsOpenAIGrammarTools: false,
		supportsMidConvoSystemMessages: false,
		supportsMidConvoToolAdditions: false,
		cacheControlFormat,
		sendSessionAffinityHeaders: isOpenRouter,
		sessionAffinityFormat: isOpenRouter ? "openrouter" : "openai",
		// OpenCode Go streams `reasoning` but expects it back as `reasoning_content`.
		reasoningReplayField: provider === "opencode-go" ? "reasoning_content" : undefined,
		toolCallIdMaxLength: provider === "openai" ? 40 : undefined,
		// Without markers the long tier is `prompt_cache_retention: "24h"`, which api.openai.com takes only for the models
		// OpenAI lists (the catalog sets the flag for them); Chat Completions has no 12h tier for GPT-5.6 and later.
		supportsLongCacheRetention:
			cacheControlFormat !== "anthropic" && matchesHost(baseUrl, "api.openai.com")
				? false
				: !(isTogether || isCloudflareWorkersAI || isCloudflareAiGateway || isNvidia || isAntLing),
		toolSchemaFlavor: isMoonshot || isMoonshotModelId(model.id) ? "moonshot" : undefined,
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
		vercelGatewayRouting: model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
		chatTemplateKwargs: model.compat.chatTemplateKwargs ?? detected.chatTemplateKwargs,
		chatTemplateArgs: model.compat.chatTemplateArgs ?? detected.chatTemplateArgs,
		zaiToolStream: model.compat.zaiToolStream ?? detected.zaiToolStream,
		supportsThinkingTokenBudget: model.compat.supportsThinkingTokenBudget ?? detected.supportsThinkingTokenBudget,
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
