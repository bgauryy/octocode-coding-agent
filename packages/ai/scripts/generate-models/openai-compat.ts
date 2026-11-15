import type { Api, Model, OpenAICompletionsCompat } from "../../src/types.ts";
import { withCacheCapabilities } from "../../src/utils/cache-capabilities.ts";
import {
	OPENAI_ADDITIONAL_TOOLS_MODEL_IDS,
	OPENAI_CODEX_ADDITIONAL_TOOLS_MODEL_IDS,
	OPENAI_MID_CONVO_EFFORT_MODEL_IDS,
	OPENAI_MID_CONVO_SYSTEM_MESSAGE_MODEL_IDS,
	OPENAI_TOOL_SEARCH_MODEL_IDS,
	TOGETHER_REASONING_ONLY_MODELS,
} from "./constants.ts";

/** OpenAI Completions and Responses compat: detected defaults, tool, transcript and prompt-cache metadata. */

// The fields detection decides. The runtime detects session affinity and the tool schema flavor
// itself (src/api/openai-completions/compat.ts), so generated metadata leaves them unset.
type OpenAICompletionsResolvedCompat = Required<
	Omit<
		OpenAICompletionsCompat,
		| "cacheControlFormat"
		| "supportsThinkingTokenBudget"
		| "thinkingTokenBudgetField"
		| "sessionAffinityFormat"
		| "vllmPriority"
		| "toolSchemaFlavor"
		| "supportsTemperature"
		| "supportsExplicitPromptCacheMode"
	>
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

const OPENAI_COMPLETIONS_DEFAULT_COMPAT: OpenAICompletionsResolvedCompat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsStrictMode: false,
	supportsOpenAIGrammarTools: false,
	supportsMidConvoSystemMessages: false,
	supportsMidConvoToolAdditions: false,
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
};

export function detectOpenAICompletionsCompat(model: Model<"openai-completions">): OpenAICompletionsResolvedCompat {
	const provider = model.provider;
	const baseUrl = model.baseUrl;

	const isZai =
		provider === "zai" ||
		provider === "zai-coding-cn" ||
		baseUrl.includes("api.z.ai") ||
		baseUrl.includes("open.bigmodel.cn");
	const isTogether =
		provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
	const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
	const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
	const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
	const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
	const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
	const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
	const isCerebras = provider === "cerebras" || baseUrl.includes("cerebras.ai");
	const isTogetherReasoningOnly = isTogether && TOGETHER_REASONING_ONLY_MODELS.has(model.id);
	// OpenCode gateways front many vendors; a vendor that rejects `strict` tool schemas fails the whole request, so
	// strict mode stays off. models.dev `structured_output` is not a usable signal: it is true for beam-free, which
	// answers 400 to a strict tool schema.
	const isOpenCodeGateway = provider === "opencode" || provider === "opencode-go" || baseUrl.includes("opencode.ai");
	const isDeepSeek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");

	const isNonStandard =
		isNvidia ||
		isCerebras ||
		provider === "xai" ||
		baseUrl.includes("api.x.ai") ||
		isTogether ||
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isZai ||
		isMoonshot ||
		provider === "opencode" ||
		baseUrl.includes("opencode.ai") ||
		isCloudflareWorkersAI ||
		isCloudflareAiGateway ||
		isAntLing;

	const useMaxTokens =
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isMoonshot ||
		isCloudflareAiGateway ||
		isTogether ||
		isNvidia ||
		isAntLing ||
		isZai;

	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	const isOpenRouterDeveloperRoleModel =
		isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
	const cacheControlFormat = provider === "openrouter" && /^~?anthropic\//.test(model.id) ? "anthropic" : undefined;

	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
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
				: isTogether && !isTogetherReasoningOnly
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
		// Preserve built-in behavior as explicit metadata against the conservative runtime default.
		supportsStrictMode:
			!isOpenCodeGateway && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isCerebras,
		supportsOpenAIGrammarTools: false,
		supportsMidConvoSystemMessages: false,
		supportsMidConvoToolAdditions: false,
		...(cacheControlFormat ? { cacheControlFormat } : {}),
		sendSessionAffinityHeaders: isOpenRouter,
		supportsLongCacheRetention: !(
			isTogether ||
			isCloudflareWorkersAI ||
			isCloudflareAiGateway ||
			isNvidia ||
			isAntLing
		),
	};
}

function isPlainEmptyObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

function openAICompletionsCompatDelta(compat: OpenAICompletionsResolvedCompat): OpenAICompletionsCompat {
	const delta: OpenAICompletionsCompat = {};
	for (const [key, value] of Object.entries(compat)) {
		const defaultValue = OPENAI_COMPLETIONS_DEFAULT_COMPAT[key as keyof OpenAICompletionsResolvedCompat];
		if (isPlainEmptyObject(value) && isPlainEmptyObject(defaultValue)) continue;
		if (value !== defaultValue) {
			(delta as Record<string, unknown>)[key] = value;
		}
	}
	return delta;
}

export function applyOpenAICompletionsCompatMetadata(model: Model<Api>): void {
	if (model.api !== "openai-completions") return;
	const detected = openAICompletionsCompatDelta(detectOpenAICompletionsCompat(model as Model<"openai-completions">));
	model.compat = { ...detected, ...model.compat };
	if (Object.keys(model.compat).length === 0) {
		delete model.compat;
	}
}

// Responses endpoints verified (OpenAI, ChatGPT Codex backend, GitHub Copilot,
// opencode zen) or documented (Azure OpenAI, Cloudflare AI Gateway) to pass
// OpenAI custom grammar tools through. OpenAI rejects `type: "custom"` tools
// for pre-GPT-5 models (gpt-4.x, gpt-4o, o-series).
const OPENAI_GRAMMAR_TOOL_PROVIDERS = new Set([
	"openai",
	"openai-codex",
	"azure",
	"github-copilot",
	"opencode",
	"cloudflare-ai-gateway",
]);
const OPENAI_GRAMMAR_TOOL_APIS = new Set<Api>(["openai-responses", "azure-openai-responses", "openai-codex-responses"]);

export function applyOpenAIGrammarToolCompatMetadata(model: Model<Api>): void {
	if (!OPENAI_GRAMMAR_TOOL_APIS.has(model.api) || !OPENAI_GRAMMAR_TOOL_PROVIDERS.has(model.provider)) return;
	const match = /^gpt-(\d+)/.exec(model.id);
	if (!match || Number(match[1]) < 5) return;
	model.compat = { ...model.compat, supportsOpenAIGrammarTools: true };
}

export function applyOpenAIToolSearchMetadata(model: Model<Api>): void {
	const isOpenAIResponses = model.provider === "openai" && model.api === "openai-responses";
	const isOpenAICodex = model.provider === "openai-codex" && model.api === "openai-codex-responses";
	if (!(isOpenAIResponses || isOpenAICodex) || !OPENAI_TOOL_SEARCH_MODEL_IDS.has(model.id)) return;
	const supportsAdditionalTools =
		(isOpenAIResponses && OPENAI_ADDITIONAL_TOOLS_MODEL_IDS.has(model.id)) ||
		(isOpenAICodex && OPENAI_CODEX_ADDITIONAL_TOOLS_MODEL_IDS.has(model.id));
	model.compat = {
		...model.compat,
		...(supportsAdditionalTools ? { supportsAdditionalTools: true } : {}),
		supportsToolSearch: true,
	};
}

// Moonshot Kimi K2.6/K2.7 accept system text after the conversation starts but reject
// tool-bearing system messages. Kimi K3 accepts both forms; Fireworks and OpenCode pass
// its tool-bearing form through. GitHub Copilot forwards K3 text but silently drops its
// tool-bearing message. DeepSeek V4 Pro and OpenAI models behind OpenRouter also accept
// plain system text in place. Kimi Coding sets these flags in createKimiCodingModels().
export function applyOpenAICompletionsTranscriptMetadata(model: Model<Api>): void {
	if (model.api !== "openai-completions") return;
	const isKimiK3 =
		(model.provider.startsWith("moonshot") && model.id === "kimi-k3") ||
		(model.provider === "fireworks" && model.id.includes("kimi-k3")) ||
		((model.provider === "opencode" || model.provider === "opencode-go") && model.id === "kimi-k3");
	const isMoonshotKimiK2 =
		model.provider.startsWith("moonshot") &&
		(model.id === "kimi-k2.6" || model.id === "kimi-k2.7-code" || model.id === "kimi-k2.7-code-highspeed");
	const isTextOnly =
		isMoonshotKimiK2 ||
		(model.provider === "github-copilot" && model.id === "kimi-k3") ||
		(model.provider === "deepseek" && model.id === "deepseek-v4-pro") ||
		(model.provider === "openrouter" &&
			model.id.startsWith("openai/") &&
			OPENAI_MID_CONVO_SYSTEM_MESSAGE_MODEL_IDS.has(model.id.slice("openai/".length)));
	if (!isKimiK3 && !isTextOnly) return;
	model.compat = {
		...model.compat,
		supportsMidConvoSystemMessages: true,
		...(isKimiK3 ? { supportsMidConvoToolAdditions: true } : {}),
	};
}

// Newer OpenAI Responses models accept developer messages after the conversation has started.
// OpenCode Zen, OpenCode Go, and GitHub Copilot pass both those messages and
// `additional_tools` items through to OpenAI unchanged; tool search is not verified
// through those proxies.
const OPENAI_RESPONSES_PROXY_PROVIDERS = new Set(["opencode", "opencode-go", "github-copilot"]);

export function applyOpenAIResponsesTranscriptMetadata(model: Model<Api>): void {
	const isOpenAIResponses = model.provider === "openai" && model.api === "openai-responses";
	const isOpenAICodex = model.provider === "openai-codex" && model.api === "openai-codex-responses";
	const isProxiedResponses = OPENAI_RESPONSES_PROXY_PROVIDERS.has(model.provider) && model.api === "openai-responses";
	if (
		!(isOpenAIResponses || isOpenAICodex || isProxiedResponses) ||
		!OPENAI_MID_CONVO_SYSTEM_MESSAGE_MODEL_IDS.has(model.id)
	) {
		return;
	}
	model.compat = {
		...model.compat,
		supportsMidConvoSystemMessages: true,
		...(isProxiedResponses ? { supportsAdditionalTools: true } : {}),
	};
}

export function applyOpenAIExplicitPromptCacheMetadata(model: Model<Api>): void {
	model.compat = withCacheCapabilities(model).compat;
}

// GPT-6 models accept `configuration_update` input items that change the reasoning effort
// without changing the cached prompt prefix. Not enabled for openai-codex (Codex CLI keeps it
// behind a flag that is off by default) or proxies.
export function applyOpenAIMidConvoEffortMetadata(model: Model<Api>): void {
	if (model.provider !== "openai" || model.api !== "openai-responses") return;
	if (!OPENAI_MID_CONVO_EFFORT_MODEL_IDS.has(model.id)) return;
	model.compat = {
		...model.compat,
		supportsMidConvoEffort: true,
	};
}
