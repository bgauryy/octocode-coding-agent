# Custom Providers

Part of the [`@octocodeai/octocode-ai` guide](../README.md).

## createProvider()

`createProvider()` builds a provider from parts: identity, auth, a model list, and an API implementation (`api` for chat models, `images` for image generation, `classifiers` for classification; at least one is required, see [Image Generation](images.md#image-generation)). Use it for local inference servers, proxies, or any OpenAI/Anthropic-compatible endpoint:

```typescript
import { createModels, createProvider, envApiKeyAuth, type Model } from "@octocodeai/octocode-ai";
import { openAICompletionsApi } from "@octocodeai/octocode-ai/api/openai-completions.lazy";

const ollamaModel: Model<"openai-completions"> = {
	id: "llama-3.1-8b",
	name: "Llama 3.1 8B (Ollama)",
	api: "openai-completions",
	provider: "ollama",
	baseUrl: "http://localhost:11434/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 32000,
};

const ollama = createProvider({
	id: "ollama",
	name: "Ollama",
	baseUrl: "http://localhost:11434/v1",
	// Every provider declares auth; keyless local servers resolve as configured with no key.
	auth: { apiKey: { name: "Ollama", resolve: async () => ({ auth: {} }) } },
	models: [ollamaModel],
	api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(ollama);

await models.complete(models.getModel("ollama", "llama-3.1-8b")!, context);
```

For providers with real keys, `envApiKeyAuth(displayName, envVars)` gives the standard behavior (stored credential wins, then the first set env var):

```typescript
const proxy = createProvider({
	id: "my-proxy",
	auth: { apiKey: envApiKeyAuth("My proxy API key", ["MY_PROXY_API_KEY"]) },
	models: [/* ... */],
	api: openAICompletionsApi(),
});
```

Mixed-API providers pass a map keyed by `model.api`; each model dispatches to its API's implementation:

```typescript
import { anthropicMessagesApi } from "@octocodeai/octocode-ai/api/anthropic-messages.lazy";
import { openAIResponsesApi } from "@octocodeai/octocode-ai/api/openai-responses.lazy";

const gateway = createProvider({
	id: "my-gateway",
	auth: { apiKey: envApiKeyAuth("Gateway key", ["GATEWAY_API_KEY"]) },
	models: [/* models with api: 'anthropic-messages' or 'openai-responses' */],
	api: {
		"anthropic-messages": anthropicMessagesApi(),
		"openai-responses": openAIResponsesApi(),
	},
});
```

Provider-wide endpoint or request transformations belong in the provider's API implementation: wrap the `ProviderStreams` you pass as `api` so every request goes through the transformation before dispatch. The Cloudflare providers do this to materialize account/gateway endpoint placeholders from the resolved provider env:

```typescript
function tenantStreams(streams: ProviderStreams): ProviderStreams {
	const withTenant = (model: Model<Api>) => ({ ...model, baseUrl: model.baseUrl.replace("{tenant}", tenantId) });
	return {
		stream: (model, context, options) => streams.stream(withTenant(model), context, options),
		streamSimple: (model, context, options) => streams.streamSimple(withTenant(model), context, options),
	};
}

const tenantGateway = createProvider({
	id: "tenant-gateway",
	auth: { apiKey: envApiKeyAuth("Gateway key", ["GATEWAY_API_KEY"]) },
	models: [/* ... */],
	api: tenantStreams(openAICompletionsApi()),
});
```

Dynamic model lists use `fetchModels`, which can return models of every type. `Models.refresh()` refreshes every configured dynamic provider, passing its effective API-key or refreshed OAuth credential. A `ModelsStore` persists dynamic catalogs; both stores default to in-memory implementations. Its `read`, `write`, and `delete` operations accept optional cancellation, and `Models` binds those waits to the provider refresh signal.

```typescript
const models = createModels({ credentials, modelsStore });
const llamacpp = createProvider({
	id: "llamacpp",
	auth: { apiKey: { name: "llama.cpp", resolve: async () => ({ auth: {} }) } },
	models: [],
	fetchModels: async ({ signal }) => fetchModelsFromServer("http://localhost:8080", signal),
	api: openAICompletionsApi(),
});

models.setProvider(llamacpp);
const result = await models.refresh({ signal });
if (result.aborted) console.log("refresh cancelled");
for (const [provider, error] of result.errors) console.error(provider, error);
```

`Models.refresh()` is unbounded when its optional signal is omitted. Providers always receive a concrete `RefreshModelsContext.signal` and must honor it for network requests and other blocking work. When a caller supplies a signal, `Models.refresh()` returns promptly with `aborted: true` after cancellation even if a custom provider fails to cooperate; the provider must still honor the signal to stop its underlying work.

Use `models.refresh({ providers: ['openrouter'] })` to restrict work to selected providers, `models.refresh({ allowNetwork: false })` to restore persisted catalogs without network access, or `models.refresh({ force: true })` to bypass provider freshness checks. Model reads stay synchronous and return the last restored or refreshed list.

`createProvider()` handles dynamic publication and persistence automatically. Handwritten `Provider.refreshModels()` implementations receive the read-only `context.stored` snapshot and publish through `context.publish({ persist?, update? })`. Omit `persist` to leave storage unchanged, pass a `ModelsStoreEntry` to write it, or pass `persist: null` to delete it. `ModelsStoreEntry.models` contains models of every type. Publication is generation-checked; put synchronous in-memory catalog changes in `update` rather than mutating state before publication.

Custom models can carry `headers` (e.g. proxies behind bot detection) and `compat` flags. `Models.getAuth(model)` includes those model headers, and stream methods merge them before explicit request headers and `transformHeaders`. See [OpenAI Compatibility Settings](#openai-compatibility-settings).

Some OpenAI-compatible servers do not understand the `developer` role used for reasoning-capable models, so an `openai-completions` model on a host the library does not recognize sends the system prompt as a `system` message. Set `compat.supportsDeveloperRole` to `true` for a server that accepts the `developer` role, or to `false` to force `system` on a recognized host. If the server also does not support `reasoning_effort`, set `compat.supportsReasoningEffort` to `false` too. This commonly applies to Ollama, vLLM, SGLang, and similar OpenAI-compatible servers.

Use model-level `thinkingLevelMap` to describe model-specific thinking controls. Keys are Octocode thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Missing standard levels through `high` use provider defaults; `xhigh` and `max` are opt-in and require a non-null map entry. String values are sent to the provider, `null` marks a level unsupported, and maps may skip levels.

```typescript
const ollamaReasoningModel: Model<"openai-completions"> = {
	id: "gpt-oss:20b",
	name: "GPT-OSS 20B (Ollama)",
	api: "openai-completions",
	provider: "ollama",
	baseUrl: "http://localhost:11434/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 131072,
	maxTokens: 32000,
	thinkingLevelMap: {
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
	},
	compat: {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
	},
};
```

## Calling API Implementations Directly

The API implementations are importable on their own. Each module exports exactly `stream` and `streamSimple` with that API's full option typing. Direct calls bypass provider auth and context normalization — pass `apiKey` explicitly and wrap the context in `normalizeContext()`:

```typescript
import { normalizeContext } from "@octocodeai/octocode-ai";
import { stream } from "@octocodeai/octocode-ai/api/anthropic-messages";

const s = stream(claudeModel, normalizeContext(context), {
	apiKey: process.env.ANTHROPIC_API_KEY,
	thinkingEnabled: true,
	thinkingBudgetTokens: 2048,
});
```

Built-in API implementations live under `./api/<api-id>`:

| API id                    | Options type                  |
| ------------------------- | ----------------------------- |
| `anthropic-messages`      | `AnthropicOptions`            |
| `openai-completions`      | `OpenAICompletionsOptions`    |
| `openai-responses`        | `OpenAIResponsesOptions`      |
| `openai-codex-responses`  | `OpenAICodexResponsesOptions` |
| `azure-openai-responses`  | `AzureOpenAIResponsesOptions` |
| `google-generative-ai`    | `GoogleOptions`               |
| `google-vertex`           | `GoogleVertexOptions`         |
| `mistral-conversations`   | `MistralOptions`              |
| `bedrock-converse-stream` | `BedrockOptions`              |

Importing an implementation module loads its SDK. The `./api/<id>.lazy` wrappers (used by the provider factories) defer that load to the first request when the runtime or bundler supports dynamic import chunking. Legacy raw API subpaths from older releases (`./anthropic`, `./google`, `./mistral`, `./openai-completions`, ...) were removed; use `@octocodeai/octocode-ai/api/<api-id>`.

## OpenAI Compatibility Settings

The `openai-completions` API is implemented by many providers with minor differences. By default, the library auto-detects compatibility settings based on `baseUrl` for a small set of known OpenAI-compatible providers (Cerebras, xAI, Chutes, DeepSeek, NVIDIA NIM, Together AI, zAi, OpenCode, Cloudflare Workers AI, etc.). For custom proxies or unknown endpoints, you can override these settings via the `compat` field. For `openai-responses` models, the compat field supports Responses-specific flags.

```typescript
interface OpenAICompletionsCompat {
	supportsStore?: boolean; // Whether provider supports the `store` field (default: true)
	supportsDeveloperRole?: boolean; // Whether provider supports `developer` role vs `system` (default: true on OpenAI, Groq, Xiaomi and OpenRouter `openai/` and `anthropic/` models; false elsewhere)
	supportsReasoningEffort?: boolean; // Whether provider supports `reasoning_effort` (default: true)
	supportsUsageInStreaming?: boolean; // Whether provider supports `stream_options: { include_usage: true }` (default: true)
	supportsStrictMode?: boolean; // Whether provider supports `strict` in tool definitions (default: false; enabled in metadata for capable built-in models)
	supportsOpenAIGrammarTools?: boolean; // Whether to emit OpenAI custom Lark/regex grammar tools; false falls back to normal function tools (default: false; the generated catalog enables it for capable models)
	supportsMidConvoSystemMessages?: boolean; // Whether the model accepts system messages after the conversation started; false keeps the leading prompt unchanged and sends them as marked user messages (default: false; the generated catalog enables it for verified models)
	supportsMidConvoToolAdditions?: boolean; // Whether system messages can add tools mid-conversation via Kimi-style `tools` system messages; requires supportsMidConvoSystemMessages (default: false)
	sendSessionAffinityHeaders?: boolean; // Send session-affinity data from `sessionId` (default: true for OpenRouter, false otherwise)
	sessionAffinityFormat?: "openai" | "openai-nosession" | "openrouter"; // Format for session affinity: 'openai' uses `prompt_cache_key`, `session_id`, `x-client-request-id`, and `x-session-affinity`; 'openai-nosession' uses `prompt_cache_key`, `x-client-request-id`, and `x-session-affinity`; 'openrouter' uses `x-session-id` (default: auto-detected)
	maxTokensField?: "max_completion_tokens" | "max_tokens"; // Which field name to use (default: max_completion_tokens)
	requiresToolResultName?: boolean; // Whether tool results require the `name` field (default: false)
	requiresAssistantAfterToolResult?: boolean; // Whether tool results must be followed by an assistant message (default: false)
	requiresThinkingAsText?: boolean; // Whether thinking blocks must be converted to text (default: false)
	requiresReasoningContentOnAssistantMessages?: boolean; // Whether all replayed assistant messages must include empty reasoning_content when reasoning is enabled (default: auto-detected for DeepSeek)
	thinkingFormat?:
		| "openai"
		| "openrouter"
		| "deepseek"
		| "together"
		| "baseten"
		| "zai"
		| "qwen"
		| "chat-template"
		| "qwen-chat-template"
		| "string-thinking"
		| "ant-ling"; // Format for reasoning param: 'openai' uses reasoning_effort, 'openrouter' uses reasoning: { effort }, 'deepseek' uses thinking: { type } plus reasoning_effort when supported, 'together' uses reasoning: { enabled } plus reasoning_effort when supported, 'baseten' uses configurable chat_template_args plus reasoning_effort when supported, 'zai' uses thinking: { type }, 'qwen' uses enable_thinking, 'chat-template' uses configurable chat_template_kwargs, 'qwen-chat-template' uses chat_template_kwargs.enable_thinking and preserve_thinking, 'string-thinking' uses top-level thinking, 'ant-ling' uses reasoning: { effort } only for mapped efforts (default: openai)
	chatTemplateKwargs?: Record<
		string,
		| string
		| number
		| boolean
		| null
		| { $var: "thinking.enabled" | "thinking.effort" | "thinking.budget"; omitWhenOff?: boolean }
	>; // chat_template_kwargs values; use $var for Octocode-controlled thinking values
	chatTemplateArgs?: Record<
		string,
		| string
		| number
		| boolean
		| null
		| { $var: "thinking.enabled" | "thinking.effort" | "thinking.budget"; omitWhenOff?: boolean }
	>; // chat_template_args values for thinkingFormat: 'baseten'; use $var for Octocode-controlled thinking values
	thinkingTokenBudgetField?: "thinking_token_budget" | "thinking_budget" | "thinking_budget_tokens"; // Top-level field that caps reasoning tokens from thinkingBudgets (vLLM / Qwen / llama.cpp). Off by default.
	supportsThinkingTokenBudget?: boolean; // Alias for thinkingTokenBudgetField: 'thinking_token_budget' (vLLM). Prefer thinkingTokenBudgetField. Default: false.
	cacheControlFormat?: "anthropic"; // Anthropic-style cache_control on system prompt, last tool, and last user/assistant text content
	openRouterRouting?: OpenRouterRouting; // OpenRouter routing preferences (default: {})
	vercelGatewayRouting?: VercelGatewayRouting; // Vercel AI Gateway routing preferences (default: {})
}

interface OpenAIResponsesCompat {
	supportsDeveloperRole?: boolean; // Whether provider supports `developer` role vs `system` (default: true)
	sessionAffinityFormat?: "openai" | "openai-nosession" | "openrouter"; // Session-affinity header format: 'openai' sends `session_id` and `x-client-request-id`; 'openai-nosession' sends `x-client-request-id`; 'openrouter' sends `x-session-id`. Does not affect the `prompt_cache_key` body param (default: auto-detected)
	supportsLongCacheRetention?: boolean; // Whether provider supports `prompt_cache_retention: "24h"` (default: true)
	supportsStrictMode?: boolean; // Whether provider supports strict JSON-schema function tools (default: false; enabled in metadata for built-in OpenAI models)
	supportsOpenAIGrammarTools?: boolean; // Whether to emit OpenAI custom Lark/regex grammar tools; false falls back to normal function tools (default: false; the generated catalog enables it for capable models)
}
```

OpenAI Responses requests to `xai` also send `x-grok-conv-id` from `sessionId`, as the Chat Completions client does. On explicit-cache models (`supportsExplicitPromptCacheMode`, GPT-5.6+), the request TTL stays at OpenAI's default 30 minutes, which covers each turn's new history; `"none"` sends `{ mode: "explicit" }` with no breakpoints. The leading instructions carry an explicit breakpoint with the instruction retention (`ttl: "12h"` for `long`, also when a `cacheRetention: "long"` alone sets both layers). Azure, whose breakpoints take no `ttl`, keeps `long` history on `prompt_cache_options: { ttl: "12h" }`. Earlier models send `prompt_cache_retention: "24h"` when either layer is `long`; OpenAI charges no cache write for it and keeps entries typically about 30 minutes, at most 24 hours. When `instructionCacheBoundary` names a section of the leading system message, they are split before that section into two `input_text` parts that each carry the breakpoint; an absent or unknown boundary, or a prompt without sections, keeps one part. When `instructionVolatileBoundary` names a section, that section and every later one become a last part without a breakpoint, so a change there rewrites no cached part.

`promptCacheKey` optionally groups related OpenAI, Azure Responses, Codex and Mistral requests for prompt caching without sharing transport sessions. It defaults to `OCTOCODE_PROMPT_CACHE_KEY` when set, then `sessionId`. Simple APIs preserve it. The wire key is capped at 64 characters and omitted when `cacheRetention` is `"none"`; session headers and WebSocket pooling continue to use `sessionId`.

OpenRouter requests send `x-session-id` from `sessionId` when prompt caching is enabled. Chat Completions and Anthropic Messages both auto-detect OpenRouter endpoints unless `sendSessionAffinityHeaders` is explicitly false. On Anthropic-compatible models, `sessionAffinityFormat: "openrouter"` selects `x-session-id`; when unset, the existing `x-session-affinity` format is used. Explicit request headers take precedence over generated headers.

If `compat` is not set, the library falls back to URL-based detection. If `compat` is partially set, unspecified fields use the detected defaults. This is useful for:

- **LiteLLM proxies**: May not support `store` field
- **Custom inference servers**: May use non-standard field names
- **Self-hosted endpoints**: May have different feature support
