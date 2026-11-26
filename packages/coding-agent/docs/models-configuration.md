# Models Configuration

<!-- This file is generated from TypeScript source. Do not edit it manually; run yarn run generate:references. -->

This reference lists the fields of `models.json`. See [Configure a compatible endpoint](models.md#configure-a-compatible-endpoint) for examples and [Configuration](configuration.md#agent-directory) for the file location.

For editor validation and completion, point `$schema` at `schemas/models.schema.json` in the installed Octocode package.

## Providers

Each key under `providers` is a provider ID. `models.json` defines custom providers: each ID adds a provider, which needs `baseUrl` and an `api` at provider or model level. An official provider ID (such as `anthropic` or `amazon-bedrock`) is refused with a message and the other providers in the file still load; rename the entry for a custom endpoint, and set an official provider's host or key in `/providers`. What an official ID may carry is tuning and throttling: `modelOverrides` and `defaults` limited to `compat`, `contextWindow`, `maxTokens`, `inputLimits` and `cost` (a negotiated or enterprise price, with `tiers`, `until` and `after` as below; `/model` details mark it "(your price)"), and `requestsPerMinute` and `tokensPerMinute` at provider level and in `modelOverrides`. Host, API, key, headers, `auth`, `env` and `models` stay refused.

| Field | Type | Default | Description |
|---|---|---|---|
| `cacheRetention` | `"none" \| "short" \| "long"` |  | Conversation cache retention; short by default, long for sessions that often pause 5 to 60 minutes. Without a separate instruction preference, applies to both layers. |
| `instructionCacheRetention` | `"none" \| "short" \| "long"` |  | Instruction cache retention, limited by endpoint capabilities; long by default. Long writes can cost more. |
| `name` | string |  | Display name. |
| `baseUrl` | string |  | API base URL. Also applies to the provider's built-in models. |
| `apiKey` | string |  | Literal key, "$NAME" environment interpolation, "!command" output (the command runs on first use, not at startup), or "keychain:&lt;name>" (the system keychain entry of service octocode, account &lt;name>). |
| `auth` | object |  | Key command, used before env and apiKey. Its stdout, trimmed, is the key. |
| `auth.command` | string |  | Required. Program that prints the key on stdout; runs without a shell, on first use. |
| `auth.args` | `string[]` |  | Arguments, passed as they are. |
| `auth.timeoutMs` | integer | `10000` | Milliseconds before the command is stopped and the request fails. |
| `auth.ttlMs` | integer | `300000` | Milliseconds the printed key is reused; 0 runs the command for every request. A request the provider refuses (401) runs it again. |
| `env` | `string[]` |  | Environment variables that may hold the key; the first one set is used, else apiKey. |
| `api` | string |  | API for the provider's models, such as "openai-completions", "openai-responses", "anthropic-messages", or "google-generative-ai". |
| `headers` | object |  | Request headers. Values resolve like apiKey. |
| `compat` | [object](#compatibility) |  | Provider and model compatibility overrides. |
| `requestsPerMinute` | integer |  | Most requests a session sends to this provider per minute (sliding 60 s window). 0 turns the limit off. A model's value wins over its provider's, which wins over the requestsPerMinute setting. |
| `tokensPerMinute` | integer |  | Most tokens a model may use per minute across all sessions on this machine: uncached input plus output (cache reads are not counted; a Bedrock model that burns output down counts it at that rate). A request over the budget waits for room. A model's value wins over its provider's; for Bedrock Kimi the OCTOCODE_BEDROCK_KIMI_TPM environment variable wins over both. |
| `profile` | `"anthropic" \| "openai" \| "bedrock" \| "openrouter" \| "vercel" \| "opencode" \| "groq" \| "xiaomi" \| "zai" \| "together" \| "moonshot" \| "cloudflare-workers-ai" \| "cloudflare-ai-gateway" \| "nvidia" \| "ant-ling" \| "cerebras" \| "deepseek" \| "xai" \| "chutes"` |  | The provider family whose cache markers, cache lifetimes and request quirks this provider's models follow: use it for a gateway that serves another provider's models (a Claude gateway takes "anthropic"). Unset: detected from the provider id and host. An explicit compat value still wins. |
| `defaults` | [object](#provider-defaults-and-profiles) |  | Fields applied to every model of this provider, built-in and custom. A model's own field wins, then its modelOverrides entry, then these defaults, then built-in model data. |
| `authHeader` | boolean | `false` | Whether to send the resolved API key as Authorization: Bearer. |
| `models` | [`object[]`](#models) |  |  |
| `modelOverrides` | [object](#model-overrides) |  |  |

## Models

Each `models` entry adds a model to the provider. An entry whose `id` names a known model (the provider's own, else the built-in model of the vendor its `api` belongs to: Anthropic, OpenAI, Google, Azure, Vertex, Mistral or Bedrock; `claude-opus-5.5`, `claude-opus-5-5` and `anthropic/claude-opus-5-5` name one model) starts from that model's context window, output limit, thinking map, input types, prices, input limits and compatibility; the fields you set win. Cache lifetimes and long cache retention of a direct provider do not carry to another host: set `promptCache` and `compat.supportsLongCacheRetention` when your host honours them. The defaults listed below apply to a model Octocode does not know.

| Field | Type | Default | Description |
|---|---|---|---|
| `cacheRetention` | `"none" \| "short" \| "long"` |  | Conversation cache retention; short by default, long for sessions that often pause 5 to 60 minutes. Without a separate instruction preference, applies to both layers. |
| `instructionCacheRetention` | `"none" \| "short" \| "long"` |  | Instruction cache retention, limited by endpoint capabilities; long by default. Long writes can cost more. |
| `id` | string |  | Required. Model ID sent to the API. |
| `name` | string |  | Display name, also matched by --model patterns. |
| `api` | string |  | Overrides the provider api. |
| `baseUrl` | string |  | Overrides the provider baseUrl. |
| `reasoning` | boolean | `false` | Whether the model supports thinking. |
| `thinkingLevelMap` | object |  | Provider value sent for each thinking level. null marks a level unsupported. Levels the model does not map use the provider's default value through high; xhigh and max are unsupported. |
| `input` | `("text" \| "image")[]` | `["text"]` | Accepted input modalities. Include "image" only when this model and endpoint accept image attachments. |
| `inputLimits` | [object](#input-limits) |  |  |
| `cost` | object |  |  |
| `cost.input` | number |  | Required. Input cost in USD per million tokens. |
| `cost.output` | number |  | Required. Output cost in USD per million tokens. |
| `cost.cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `cost.cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |
| `cost.tiers` | `object[]` |  | Request-wide pricing tiers. The highest matching input threshold applies to the full request. |
| `cost.tiers[].inputTokensAbove` | number |  | Required. Use this tier when total request input exceeds this token count. |
| `cost.tiers[].input` | number |  | Required. Input cost in USD per million tokens. |
| `cost.tiers[].output` | number |  | Required. Output cost in USD per million tokens. |
| `cost.tiers[].cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `cost.tiers[].cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |
| `cost.until` | string |  | Last UTC day (YYYY-MM-DD, inclusive) these rates apply, for a time-limited price. Ignored without `after`. |
| `cost.after` | object |  | Rates (and tiers) charged from the day after `until`. |
| `cost.after.input` | number |  | Required. Input cost in USD per million tokens. |
| `cost.after.output` | number |  | Required. Output cost in USD per million tokens. |
| `cost.after.cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `cost.after.cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |
| `cost.after.tiers` | `object[]` |  | Request-wide pricing tiers. The highest matching input threshold applies to the full request. |
| `cost.after.tiers[].inputTokensAbove` | number |  | Required. Use this tier when total request input exceeds this token count. |
| `cost.after.tiers[].input` | number |  | Required. Input cost in USD per million tokens. |
| `cost.after.tiers[].output` | number |  | Required. Output cost in USD per million tokens. |
| `cost.after.tiers[].cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `cost.after.tiers[].cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |
| `promptCache` | object |  | Best-effort prompt cache lifetime in seconds for the short and long retention tiers. Octocode warms only tiers with a known lifetime. |
| `contextWindow` | number | `128000` | Context window in tokens. |
| `maxTokens` | number | `16384` | Maximum output tokens. |
| `samplingParams` | object |  | Fields merged into every request body. Applies only to OpenAI-compatible APIs. |
| `samplingParamsByThinkingLevel` | object |  | samplingParams per thinking level, merged over samplingParams. |
| `headers` | object |  | Request headers. Values resolve like apiKey. |
| `compat` | [object](#compatibility) |  | Provider and model compatibility overrides. |
| `requestsPerMinute` | integer |  | Most requests a session sends to this provider per minute (sliding 60 s window). 0 turns the limit off. A model's value wins over its provider's, which wins over the requestsPerMinute setting. |
| `tokensPerMinute` | integer |  | Most tokens a model may use per minute across all sessions on this machine: uncached input plus output (cache reads are not counted; a Bedrock model that burns output down counts it at that rate). A request over the budget waits for room. A model's value wins over its provider's; for Bedrock Kimi the OCTOCODE_BEDROCK_KIMI_TPM environment variable wins over both. |

## Model overrides

Each `modelOverrides` key is the ID of a built-in model. Unknown IDs are ignored. Object fields, such as `cost`, merge with the model's value field by field; other fields replace it. A `cost` override that sets any rate or `tiers` also drops the model's built-in `until`/`after` price window, so your rates stay in force after the built-in date; set `until` and `after` in the override to give it a window of its own.

| Field | Type | Default | Description |
|---|---|---|---|
| `cacheRetention` | `"none" \| "short" \| "long"` |  | Conversation cache retention; short by default, long for sessions that often pause 5 to 60 minutes. Without a separate instruction preference, applies to both layers. |
| `instructionCacheRetention` | `"none" \| "short" \| "long"` |  | Instruction cache retention, limited by endpoint capabilities; long by default. Long writes can cost more. |
| `name` | string |  | Display name, also matched by --model patterns. |
| `reasoning` | boolean |  | Whether the model supports thinking. |
| `thinkingLevelMap` | object |  | Provider value sent for each thinking level. null marks a level unsupported. Levels the model does not map use the provider's default value through high; xhigh and max are unsupported. |
| `input` | `("text" \| "image")[]` |  | Accepted input modalities. Include "image" only when this model and endpoint accept image attachments. |
| `inputLimits` | [object](#input-limits) |  |  |
| `cost` | object |  |  |
| `cost.input` | number |  | Input cost in USD per million tokens. |
| `cost.output` | number |  | Output cost in USD per million tokens. |
| `cost.cacheRead` | number |  | Cache-read cost in USD per million tokens. |
| `cost.cacheWrite` | number |  | Cache-write cost in USD per million tokens. |
| `cost.tiers` | `object[]` |  | Request-wide pricing tiers. The highest matching input threshold applies to the full request. |
| `cost.tiers[].inputTokensAbove` | number |  | Required. Use this tier when total request input exceeds this token count. |
| `cost.tiers[].input` | number |  | Required. Input cost in USD per million tokens. |
| `cost.tiers[].output` | number |  | Required. Output cost in USD per million tokens. |
| `cost.tiers[].cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `cost.tiers[].cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |
| `cost.until` | string |  | Last UTC day (YYYY-MM-DD, inclusive) these rates apply, for a time-limited price. Ignored without `after`. |
| `cost.after` | object |  | Rates (and tiers) charged from the day after `until`. |
| `cost.after.input` | number |  | Required. Input cost in USD per million tokens. |
| `cost.after.output` | number |  | Required. Output cost in USD per million tokens. |
| `cost.after.cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `cost.after.cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |
| `cost.after.tiers` | `object[]` |  | Request-wide pricing tiers. The highest matching input threshold applies to the full request. |
| `cost.after.tiers[].inputTokensAbove` | number |  | Required. Use this tier when total request input exceeds this token count. |
| `cost.after.tiers[].input` | number |  | Required. Input cost in USD per million tokens. |
| `cost.after.tiers[].output` | number |  | Required. Output cost in USD per million tokens. |
| `cost.after.tiers[].cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `cost.after.tiers[].cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |
| `promptCache` | object |  | Best-effort prompt cache lifetime in seconds for the short and long retention tiers. Octocode warms only tiers with a known lifetime. |
| `contextWindow` | number |  | Context window in tokens. |
| `maxTokens` | number |  | Maximum output tokens. |
| `samplingParams` | object |  | Fields merged into every request body. Applies only to OpenAI-compatible APIs. |
| `samplingParamsByThinkingLevel` | object |  | samplingParams per thinking level, merged over samplingParams. |
| `headers` | object |  | Request headers. Values resolve like apiKey. |
| `compat` | [object](#compatibility) |  | Provider and model compatibility overrides. |
| `requestsPerMinute` | integer |  | Most requests a session sends to this provider per minute (sliding 60 s window). 0 turns the limit off. A model's value wins over its provider's, which wins over the requestsPerMinute setting. |
| `tokensPerMinute` | integer |  | Most tokens a model may use per minute across all sessions on this machine: uncached input plus output (cache reads are not counted; a Bedrock model that burns output down counts it at that rate). A request over the budget waits for room. A model's value wins over its provider's; for Bedrock Kimi the OCTOCODE_BEDROCK_KIMI_TPM environment variable wins over both. |

## Provider defaults and profiles

`defaults` on a provider sets model fields once for every model of that provider, built-in and custom: `contextWindow`, `maxTokens`, `input`, `cost`, `thinkingLevelMap`, `promptCache`, `inputLimits`, `samplingParams`, `compat` and `reasoning`. For one field the order is: the model's own entry, its `modelOverrides` entry, the provider's `defaults`, then built-in model data. Object fields merge key by key; other fields replace.

A provider may sit in several files. They merge field by field, the narrower one winning each field it names: Octocode's project file, Pi's project file, Octocode's global files, then Pi's global files. Pi's own `models.json` loads unchanged. A project file may add models and tune defaults, but it may not change `baseUrl`, `api`, `headers`, `apiKey`, `auth` or `env` of a provider a global file also defines (nor a model's `baseUrl`, `api` or `headers`): those fields are ignored with a warning naming the file, so a project cannot send a stored key to another host. A provider only the project defines sets its own.

`tokensPerMinute` caps the tokens a model uses per minute across all sessions on the machine (uncached input plus output; cache reads are not counted). A request over the budget waits. A model's value wins over its provider's; for Bedrock Kimi, which has a built-in budget, `OCTOCODE_BEDROCK_KIMI_TPM` still overrides both.

`profile` names the provider family whose cache markers, cache lifetimes and request quirks a provider's models follow: `anthropic`, `openai`, `bedrock`, `openrouter`, `vercel`, `opencode`, `groq`, `xiaomi`, `zai`, `together`, `moonshot`, `cloudflare-workers-ai`, `cloudflare-ai-gateway`, `nvidia`, `ant-ling`, `cerebras`, `deepseek`, `xai` or `chutes`. Use it for a gateway that serves another provider's models (a Claude gateway takes `anthropic` and gets Anthropic cache markers and the 1h tier). Without it the profile is detected from the provider id and host, as before. An explicit `compat` value always wins over the profile, and the order for a model field is: model entry, `modelOverrides`, `defaults`, the profile, built-in model data. An official provider may set `profile` (it moves no key or host); a project file may set it on a provider a global file defines.

`thinkingLevelMap` in `defaults` maps thinking levels to provider values for every model of the provider. A request for a level the map marks `null` is sent as the nearest lower supported level, or as the lowest supported one when none is lower.

When an endpoint answers 400 that it does not accept `cache_control` markers, strict tool schemas or an effort setting, Octocode resends that request once without the field (it failed before any reply), remembers the rejection for the endpoint and model until the process ends, and leaves the field out of later requests.

| Field | Type | Default | Description |
|---|---|---|---|
| `reasoning` | boolean |  | Whether the model supports thinking. |
| `thinkingLevelMap` | object |  | Provider value sent for each thinking level. null marks a level unsupported. Levels the model does not map use the provider's default value through high; xhigh and max are unsupported. |
| `input` | `("text" \| "image")[]` |  | Accepted input modalities. Include "image" only when this model and endpoint accept image attachments. |
| `inputLimits` | [object](#input-limits) |  |  |
| `cost` | object |  |  |
| `cost.input` | number |  | Required. Input cost in USD per million tokens. |
| `cost.output` | number |  | Required. Output cost in USD per million tokens. |
| `cost.cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `cost.cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |
| `cost.tiers` | `object[]` |  | Request-wide pricing tiers. The highest matching input threshold applies to the full request. |
| `cost.tiers[].inputTokensAbove` | number |  | Required. Use this tier when total request input exceeds this token count. |
| `cost.tiers[].input` | number |  | Required. Input cost in USD per million tokens. |
| `cost.tiers[].output` | number |  | Required. Output cost in USD per million tokens. |
| `cost.tiers[].cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `cost.tiers[].cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |
| `cost.until` | string |  | Last UTC day (YYYY-MM-DD, inclusive) these rates apply, for a time-limited price. Ignored without `after`. |
| `cost.after` | object |  | Rates (and tiers) charged from the day after `until`. |
| `cost.after.input` | number |  | Required. Input cost in USD per million tokens. |
| `cost.after.output` | number |  | Required. Output cost in USD per million tokens. |
| `cost.after.cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `cost.after.cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |
| `cost.after.tiers` | `object[]` |  | Request-wide pricing tiers. The highest matching input threshold applies to the full request. |
| `cost.after.tiers[].inputTokensAbove` | number |  | Required. Use this tier when total request input exceeds this token count. |
| `cost.after.tiers[].input` | number |  | Required. Input cost in USD per million tokens. |
| `cost.after.tiers[].output` | number |  | Required. Output cost in USD per million tokens. |
| `cost.after.tiers[].cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `cost.after.tiers[].cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |
| `promptCache` | object |  | Best-effort prompt cache lifetime in seconds for the short and long retention tiers. Octocode warms only tiers with a known lifetime. |
| `contextWindow` | number |  | Context window in tokens. |
| `maxTokens` | number |  | Maximum output tokens. |
| `samplingParams` | object |  | Fields merged into every request body. Applies only to OpenAI-compatible APIs. |
| `samplingParamsByThinkingLevel` | object |  | samplingParams per thinking level, merged over samplingParams. |
| `compat` | [object](#compatibility) |  | Provider and model compatibility overrides. |

## Input limits

See [Describe model input and caching](models.md#describe-model-input-and-caching).

| Field | Type | Default | Description |
|---|---|---|---|
| `maxInputTokens` | integer |  | Maximum prompt tokens accepted independently of the combined context window. |
| `maxRequestBytes` | integer |  | Maximum serialized provider request size in bytes. |
| `images` | object |  |  |
| `images.resize` | object |  | Cache-safe resize profile applied before a new image enters conversation history. |
| `images.resize.maxWidth` | integer |  |  |
| `images.resize.maxHeight` | integer |  |  |
| `images.resize.maxBytes` | integer |  | Maximum base64-encoded payload size in bytes. |
| `images.resize.jpegQuality` | integer |  |  |
| `images.maxPerMessage` | integer |  | Maximum images accepted in one provider message. |
| `images.maxPerRequest` | integer |  | Maximum images accepted across one provider request. |

## Compatibility

`compat` describes verified differences from an API's standard request and response behavior. Model values override provider values per field. The fields that apply depend on the model's `api`.

### `openai-completions`

| Field | Type | Default | Description |
|---|---|---|---|
| `supportsStore` | boolean |  | Whether the provider supports the store field. Default: auto-detected from URL. |
| `supportsDeveloperRole` | boolean |  | Whether the provider supports the developer role instead of system. Default: auto-detected from URL. |
| `supportsReasoningEffort` | boolean |  | Whether the provider supports reasoning_effort. Default: auto-detected from URL. |
| `supportsUsageInStreaming` | boolean | `true` | Whether the provider supports stream_options.include_usage for token usage in streaming responses. |
| `supportsFinishReason` | boolean | `true` | Whether streamed responses include finish_reason. When false, Octocode infers stop or toolUse when the stream ends. |
| `maxTokensField` | `"max_completion_tokens" \| "max_tokens"` |  | Which field to use for max tokens. Default: auto-detected from URL. |
| `requiresToolResultName` | boolean |  | Whether tool results require the name field. Default: auto-detected from URL. |
| `requiresAssistantAfterToolResult` | boolean |  | Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL. |
| `requiresThinkingAsText` | boolean |  | Whether thinking blocks must be converted to text blocks with &lt;thinking> delimiters. Default: auto-detected from URL. |
| `requiresReasoningContentOnAssistantMessages` | boolean |  | Whether all replayed assistant messages must include an empty reasoning_content field when reasoning is enabled. Default: auto-detected from URL. |
| `thinkingFormat` | `"openai" \| "openrouter" \| "deepseek" \| "together" \| "baseten" \| "zai" \| "qwen" \| "chat-template" \| "qwen-chat-template" \| "string-thinking" \| "ant-ling"` |  | Format for reasoning or thinking parameters. When omitted, Octocode auto-detects the format from the provider URL. "openai" uses reasoning_effort, "openrouter" uses reasoning.effort, "deepseek" uses thinking.type plus reasoning_effort when supported, "together" uses reasoning.enabled plus reasoning_effort when supported, "baseten" uses configurable chat_template_args plus reasoning_effort when supported, "zai" uses thinking.type, "qwen" uses top-level enable_thinking, "qwen-chat-template" uses chat_template_kwargs.enable_thinking and preserve_thinking, "chat-template" uses configurable chat_template_kwargs, "string-thinking" uses top-level thinking, and "ant-ling" uses reasoning.effort only when the mapped effort is non-null. |
| `chatTemplateKwargs` | object |  | Kwargs sent as chat_template_kwargs when thinkingFormat is "chat-template". Use $var with "thinking.enabled", "thinking.effort", or "thinking.budget" for Octocode-controlled values. |
| `chatTemplateArgs` | object |  | Arguments sent as chat_template_args when thinkingFormat is "baseten". Use $var with "thinking.enabled", "thinking.effort", or "thinking.budget" for Octocode-controlled values. |
| `openRouterRouting` | object |  | OpenRouter provider routing preferences. Controls which upstream providers OpenRouter routes requests to. Sent as the provider field in the OpenRouter API request body. See https://openrouter.ai/docs/guides/routing/provider-selection. |
| `openRouterAutoRouter` | object |  | OpenRouter Auto Router plugin controls for openrouter/auto and openrouter/auto-beta, sent as an auto-router plugin entry. See https://openrouter.ai/docs/guides/routing/routers/auto-router. |
| `openRouterAutoRouter.allowed_models` | `string[]` |  | Hard allow list of model patterns, for example ["anthropic/*", "openai/gpt-5.1"]. |
| `openRouterAutoRouter.excluded_models` | `string[]` |  | Model patterns the router never selects. Applied after allowed_models. |
| `openRouterAutoRouter.cost_tier` | `"low" \| "medium" \| "high"` |  | Routing policy: low favors cost, medium balances, high favors capability. |
| `openRouterAutoRouter.metadata` | boolean |  | Request router metadata (X-OpenRouter-Metadata) and record a sanitized summary as an assistant diagnostic. Default: true for openrouter/auto. |
| `vercelGatewayRouting` | object |  | Vercel AI Gateway routing preferences, sent as providerOptions.gateway on Chat Completions and Anthropic Messages requests. See https://vercel.com/docs/ai-gateway/models-and-providers/provider-options. |
| `zaiToolStream` | boolean | `false` | Whether z.ai supports top-level tool_stream for streaming tool call deltas. |
| `thinkingTokenBudgetField` | `"thinking_token_budget" \| "thinking_budget" \| "thinking_budget_tokens"` |  | Top-level request field used to cap reasoning tokens from thinkingBudgets. Reasoning and the answer share max_tokens on these endpoints. "thinking_token_budget" is vLLM, "thinking_budget" is Qwen, DashScope, or SGLang, and "thinking_budget_tokens" is llama.cpp. Off by default and not set on the generated catalog. |
| `supportsOpenAIGrammarTools` | boolean | `false` | Whether the provider supports OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. The generated catalog enables this for capable models. |
| `supportsMidConvoSystemMessages` | boolean | `false` | Whether the exact model accepts system or developer messages after the conversation has started. When false, the leading system message stays unchanged and later system messages are sent as marked user messages. The generated catalog enables this for verified models. |
| `supportsMidConvoToolAdditions` | boolean | `false` | Whether system messages can introduce additional tools mid-conversation. Requires supportsMidConvoSystemMessages. The generated catalog enables this for capable models. |
| `supportsTemperature` | boolean | `true` | Whether the model accepts the temperature request field. When false, temperature is omitted. |
| `supportsStrictMode` | boolean | `false` | Whether the provider supports the strict field in tool definitions. Generated capable models enable it explicitly. |
| `cacheControlFormat` | `"anthropic"` |  | Cache control convention for prompt caching. Anthropic applies cache_control markers to the system prompt, last tool definition, and last user, assistant, or tool-result text content. |
| `sendSessionAffinityHeaders` | boolean |  | Whether to send session-affinity data from options.sessionId. Default: true for OpenRouter endpoints, false otherwise. |
| `sessionAffinityFormat` | `"openai" \| "openai-nosession" \| "openrouter"` |  | Session-affinity header format. openai sends session_id, x-client-request-id, and x-session-affinity; openai-nosession sends x-client-request-id and x-session-affinity; openrouter sends x-session-id. Does not affect prompt_cache_key. Default: auto-detected. |
| `supportsLongCacheRetention` | boolean |  | Whether the provider supports long prompt cache retention (prompt_cache_retention: "24h" or Anthropic-style cache_control.ttl: "1h", depending on format). Default: auto-detected from provider and URL. |
| `supportsExplicitPromptCacheMode` | boolean | `false` | Whether the model is GPT-5.6 or later, which replaces prompt_cache_retention with prompt_cache_options. Chat Completions then sends no long-retention field. The generated catalog sets it for verified models; unset means false. |
| `vllmPriority` | number |  | vLLM scheduler priority sent as the top-level priority request field. Lower values are handled earlier and the server default is 0. Only meaningful with --scheduling-policy priority. Off by default and not set on the generated catalog. |
| `toolSchemaFlavor` | `"standard" \| "moonshot"` |  | Tool declaration format for Chat Completions. Moonshot endpoints and Kimi model IDs use "moonshot", including through gateways. It projects object alternatives and represents scalar choices with enums. Set "standard" to send the authored JSON Schema. Local validation uses the original tool contract. |

### `openai-responses`

Also applies to `openresponses` and `azure-openai-responses`.

| Field | Type | Default | Description |
|---|---|---|---|
| `supportsDeveloperRole` | boolean | `true` | Whether the provider supports the developer role instead of system. |
| `supportsMidConvoSystemMessages` | boolean | `false` | Whether the exact model accepts developer or system messages after the conversation has started. When false, the leading system message stays unchanged and later system messages are sent as marked user messages. The generated catalog enables this for verified models. |
| `sessionAffinityFormat` | `"openai" \| "openai-nosession" \| "openrouter"` |  | Session-affinity header format. openai sends session_id and x-client-request-id; openai-nosession sends x-client-request-id; openrouter sends x-session-id. Does not affect prompt_cache_key. Default: auto-detected. |
| `supportsLongCacheRetention` | boolean |  | Whether the provider supports long prompt cache retention. This uses prompt_cache_options.ttl: "12h" for long history on GPT-5.6+ and prompt_cache_retention: "24h" on earlier models. Default: true on OpenAI's API for GPT-5.6+ in explicit cache mode and for the models OpenAI lists for 24h retention; false elsewhere. |
| `supportsTemperature` | boolean | `true` | Whether the model accepts the temperature request field. When false, temperature is omitted. |
| `supportsStrictMode` | boolean |  | Whether the provider supports strict JSON-schema function tools. Defaults are API-specific; generated OpenAI models enable it explicitly. |
| `supportsOpenAIGrammarTools` | boolean | `false` | Whether to emit OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. The generated catalog enables this for capable models. |
| `supportsAdditionalTools` | boolean | `false` | Whether the model supports message-anchored additional_tools input items. |
| `supportsToolSearch` | boolean | `false` | Whether the model supports client-executed tool search for transcript-anchored additions. |
| `supportsExplicitPromptCacheMode` | boolean | `false` | Whether the model accepts prompt_cache_options. Older OpenAI models reject the parameter. |
| `supportsInstructionBreakpoints` | boolean | `false` | Whether the model takes 30m prompt cache breakpoints on its leading instructions without explicit cache mode (Azure deployments of GPT-6 Astra). The generated catalog sets it for verified models; unset means false. |
| `supportsMidConvoEffort` | boolean | `false` | Whether thinking level changes are sent as configuration_update input items instead of changing reasoning.effort, so a change keeps the prompt cache. Only used by the openai-responses API, and ignored with Sign in with ChatGPT on the openai provider. |
| `supportsMaxOutputTokens` | boolean | `true` | Whether the provider accepts max_output_tokens. Some Codex-protocol gateways reject it. |

### `anthropic-messages`

| Field | Type | Default | Description |
|---|---|---|---|
| `supportsEagerToolInputStreaming` | boolean | `true` | Whether the provider accepts per-tool eager_input_streaming. When false, the Anthropic provider omits tools[].eager_input_streaming and sends the legacy fine-grained-tool-streaming-2025-05-14 beta header for tool-enabled requests. |
| `supportsLongCacheRetention` | boolean |  | Whether the provider supports Anthropic long cache retention (the 1h tier) through cache_control.ttl. Default: true on api.anthropic.com and OpenCode, whose documentation verifies the 1h tier; false for gateways (OpenRouter, Vercel, Cloudflare, Copilot, MiniMax and others) and for a models.json model on its own host, which use the 5-minute tier unless this is set to true. |
| `sendSessionAffinityHeaders` | boolean |  | Whether to send x-session-affinity from options.sessionId when caching is enabled. Required for providers like Fireworks that use session affinity for prompt cache routing; requests to the same replica maximize cache hits. Default: true for OpenRouter endpoints, false otherwise. |
| `sessionAffinityFormat` | `"openrouter"` |  | Session-affinity format. openrouter sends x-session-id; when unset, sends x-session-affinity. |
| `supportsCacheControlOnTools` | boolean | `true` | Whether the provider supports Anthropic-style cache_control markers on tool definitions. When false, cache_control is omitted from tool parameters. Some Anthropic-compatible providers, such as Fireworks, do not support this field on tools and may reject or ignore it. |
| `supportsTemperature` | boolean | `true` | Whether the model accepts the Anthropic temperature request field. Claude Opus 4.7+ rejects non-default values. |
| `forceAdaptiveThinking` | boolean | `false` | Whether to force adaptive thinking (thinking.type: adaptive plus output_config.effort) regardless of model ID. Built-in models that require adaptive thinking set this in generated metadata. Custom Anthropic-compatible providers can set this to true for any model whose upstream requires the adaptive format. Set false to opt out on overridden built-in models. |
| `allowEmptySignature` | boolean | `false` | Whether to replay empty thinking signatures instead of converting thinking to text. |
| `supportsStrictTools` | boolean | `false` | Whether the provider supports Anthropic strict tool schemas. Generated Anthropic models enable it explicitly. |
| `supportsMidConvoEffort` | boolean | `false` | Whether the exact model transport supports effort-only system messages and thinking binding controls. |
| `supportsMidConvoSystemMessages` | boolean | `false` | Whether the exact model accepts system-role messages inside the conversation. When false, the top-level system prompt stays unchanged and later system messages are sent as marked user messages. |
| `supportsMidConvoToolChanges` | boolean | `false` | Whether the exact model accepts mid-conversation tool_addition and tool_removal blocks. Requires supportsMidConvoSystemMessages. |
| `vercelGatewayRouting` | object |  | Vercel AI Gateway routing preferences, sent as providerOptions.gateway on Chat Completions and Anthropic Messages requests. See https://vercel.com/docs/ai-gateway/models-and-providers/provider-options. |
| `allowedFallbackModels` | `object[]` |  | Models Anthropic accepts for server-side refusal fallback, with local pricing metadata for returned fallback responses. When absent or empty, callers must omit fallbacks; Anthropic rejects the field for models with no permitted fallback targets. |
| `allowedFallbackModels[].provider` | string |  | Required. |
| `allowedFallbackModels[].model` | string |  | Required. |
| `allowedFallbackModels[].cost` | object |  | Required. |
| `allowedFallbackModels[].cost.input` | number |  | Required. Input cost in USD per million tokens. |
| `allowedFallbackModels[].cost.output` | number |  | Required. Output cost in USD per million tokens. |
| `allowedFallbackModels[].cost.cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `allowedFallbackModels[].cost.cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |
| `allowedFallbackModels[].cost.tiers` | `object[]` |  | Request-wide pricing tiers. The highest matching input threshold applies to the full request. |
| `allowedFallbackModels[].cost.tiers[].inputTokensAbove` | number |  | Required. Use this tier when total request input exceeds this token count. |
| `allowedFallbackModels[].cost.tiers[].input` | number |  | Required. Input cost in USD per million tokens. |
| `allowedFallbackModels[].cost.tiers[].output` | number |  | Required. Output cost in USD per million tokens. |
| `allowedFallbackModels[].cost.tiers[].cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `allowedFallbackModels[].cost.tiers[].cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |
| `allowedFallbackModels[].cost.until` | string |  | Last UTC day (YYYY-MM-DD, inclusive) these rates apply, for a time-limited price. Ignored without `after`. |
| `allowedFallbackModels[].cost.after` | object |  | Rates (and tiers) charged from the day after `until`. |
| `allowedFallbackModels[].cost.after.input` | number |  | Required. Input cost in USD per million tokens. |
| `allowedFallbackModels[].cost.after.output` | number |  | Required. Output cost in USD per million tokens. |
| `allowedFallbackModels[].cost.after.cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `allowedFallbackModels[].cost.after.cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |
| `allowedFallbackModels[].cost.after.tiers` | `object[]` |  | Request-wide pricing tiers. The highest matching input threshold applies to the full request. |
| `allowedFallbackModels[].cost.after.tiers[].inputTokensAbove` | number |  | Required. Use this tier when total request input exceeds this token count. |
| `allowedFallbackModels[].cost.after.tiers[].input` | number |  | Required. Input cost in USD per million tokens. |
| `allowedFallbackModels[].cost.after.tiers[].output` | number |  | Required. Output cost in USD per million tokens. |
| `allowedFallbackModels[].cost.after.tiers[].cacheRead` | number |  | Required. Cache-read cost in USD per million tokens. |
| `allowedFallbackModels[].cost.after.tiers[].cacheWrite` | number |  | Required. Cache-write cost in USD per million tokens. |

### `bedrock-converse-stream`

| Field | Type | Default | Description |
|---|---|---|---|
| `supportsStrictMode` | boolean | `false` | Whether the model supports Bedrock strict tool schemas. |
| `supportsLongCacheRetention` | boolean | `true` | Whether cacheRetention "long" sends one-hour cache points. Set false for models or regions that reject the ttl field. |

### `mistral-conversations`

| Field | Type | Default | Description |
|---|---|---|---|
| `supportsMidConvoSystemMessages` | boolean | `false` | Whether the exact model accepts system messages after the conversation has started. When false, the leading system message stays unchanged and later system messages are sent as marked user messages. |
| `supportsTemperature` | boolean | `true` | Whether the model accepts the temperature request field. When false, temperature is omitted. |
| `supportsStrictMode` | boolean | `true` | Whether the model accepts the strict field in tool definitions. When false, tools are sent without it. |

### `google-generative-ai`

Also applies to `google-vertex`.

| Field | Type | Default | Description |
|---|---|---|---|
| `supportsTemperature` | boolean | `true` | Whether the model accepts the temperature request field. When false, temperature is omitted. |
