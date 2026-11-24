import { Type } from "typebox";
import {
	ChatTemplateKwargValueSchema,
	OpenRouterAutoRouterSchema,
	OpenRouterRoutingSchema,
	optionalCompatBoolean,
	optionalSessionAffinityFormat,
	thinkingTokenBudgetField,
	VercelGatewayRoutingSchema,
} from "./common.ts";

export const OpenAICompletionsCompatSchema = Type.Object(
	{
		supportsStore: Type.Optional(
			Type.Boolean({
				description: "Whether the provider supports the store field. Default: auto-detected from URL.",
			}),
		),
		supportsDeveloperRole: optionalCompatBoolean({
			description:
				"Whether the provider supports the developer role instead of system. Default: auto-detected from URL.",
		}),
		supportsReasoningEffort: Type.Optional(
			Type.Boolean({
				description: "Whether the provider supports reasoning_effort. Default: auto-detected from URL.",
			}),
		),
		supportsUsageInStreaming: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider supports stream_options.include_usage for token usage in streaming responses.",
				default: true,
			}),
		),
		supportsFinishReason: Type.Optional(
			Type.Boolean({
				description:
					"Whether streamed responses include finish_reason. When false, Octocode infers stop or toolUse when the stream ends.",
				default: true,
			}),
		),
		maxTokensField: Type.Optional(
			Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")], {
				description: "Which field to use for max tokens. Default: auto-detected from URL.",
			}),
		),
		requiresToolResultName: Type.Optional(
			Type.Boolean({ description: "Whether tool results require the name field. Default: auto-detected from URL." }),
		),
		requiresAssistantAfterToolResult: Type.Optional(
			Type.Boolean({
				description:
					"Whether a user message after tool results requires an assistant message in between. Default: auto-detected from URL.",
			}),
		),
		requiresThinkingAsText: Type.Optional(
			Type.Boolean({
				description:
					"Whether thinking blocks must be converted to text blocks with <thinking> delimiters. Default: auto-detected from URL.",
			}),
		),
		requiresReasoningContentOnAssistantMessages: Type.Optional(
			Type.Boolean({
				description:
					"Whether all replayed assistant messages must include an empty reasoning_content field when reasoning is enabled. Default: auto-detected from URL.",
			}),
		),
		thinkingFormat: Type.Optional(
			Type.Union(
				[
					Type.Literal("openai"),
					Type.Literal("openrouter"),
					Type.Literal("deepseek"),
					Type.Literal("together"),
					Type.Literal("baseten"),
					Type.Literal("zai"),
					Type.Literal("qwen"),
					Type.Literal("chat-template"),
					Type.Literal("qwen-chat-template"),
					Type.Literal("string-thinking"),
					Type.Literal("ant-ling"),
				],
				{
					description:
						'Format for reasoning or thinking parameters. When omitted, Octocode auto-detects the format from the provider URL. "openai" uses reasoning_effort, "openrouter" uses reasoning.effort, "deepseek" uses thinking.type plus reasoning_effort when supported, "together" uses reasoning.enabled plus reasoning_effort when supported, "baseten" uses configurable chat_template_args plus reasoning_effort when supported, "zai" uses thinking.type, "qwen" uses top-level enable_thinking, "qwen-chat-template" uses chat_template_kwargs.enable_thinking and preserve_thinking, "chat-template" uses configurable chat_template_kwargs, "string-thinking" uses top-level thinking, and "ant-ling" uses reasoning.effort only when the mapped effort is non-null.',
				},
			),
		),
		chatTemplateKwargs: Type.Optional(
			Type.Record(Type.String(), ChatTemplateKwargValueSchema, {
				description:
					'Kwargs sent as chat_template_kwargs when thinkingFormat is "chat-template". Use $var with "thinking.enabled", "thinking.effort", or "thinking.budget" for Octocode-controlled values.',
			}),
		),
		chatTemplateArgs: Type.Optional(
			Type.Record(Type.String(), ChatTemplateKwargValueSchema, {
				description:
					'Arguments sent as chat_template_args when thinkingFormat is "baseten". Use $var with "thinking.enabled", "thinking.effort", or "thinking.budget" for Octocode-controlled values.',
			}),
		),
		openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
		openRouterAutoRouter: Type.Optional(OpenRouterAutoRouterSchema),
		vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
		zaiToolStream: Type.Optional(
			Type.Boolean({
				description: "Whether z.ai supports top-level tool_stream for streaming tool call deltas.",
				default: false,
			}),
		),
		thinkingTokenBudgetField: Type.Optional(
			thinkingTokenBudgetField({
				description:
					'Top-level request field used to cap reasoning tokens from thinkingBudgets. Reasoning and the answer share max_tokens on these endpoints. "thinking_token_budget" is vLLM, "thinking_budget" is Qwen, DashScope, or SGLang, and "thinking_budget_tokens" is llama.cpp. Off by default and not set on the generated catalog.',
			}),
		),
		supportsOpenAIGrammarTools: optionalCompatBoolean({
			description:
				"Whether the provider supports OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. The generated catalog enables this for capable models.",
			default: false,
		}),
		supportsMidConvoSystemMessages: optionalCompatBoolean({
			description:
				"Whether the exact model accepts system or developer messages after the conversation has started. When false, the leading system message stays unchanged and later system messages are sent as marked user messages. The generated catalog enables this for verified models.",
			default: false,
		}),
		supportsMidConvoToolAdditions: Type.Optional(
			Type.Boolean({
				description:
					"Whether system messages can introduce additional tools mid-conversation. Requires supportsMidConvoSystemMessages. The generated catalog enables this for capable models.",
				default: false,
			}),
		),
		supportsTemperature: optionalCompatBoolean({
			description: "Whether the model accepts the temperature request field. When false, temperature is omitted.",
			default: true,
		}),
		supportsStrictMode: optionalCompatBoolean({
			description:
				"Whether the provider supports the strict field in tool definitions. Generated capable models enable it explicitly.",
			default: false,
		}),
		cacheControlFormat: Type.Optional(
			Type.Literal("anthropic", {
				description:
					"Cache control convention for prompt caching. Anthropic applies cache_control markers to the system prompt, last tool definition, and last user, assistant, or tool-result text content.",
			}),
		),
		sendSessionAffinityHeaders: optionalCompatBoolean({
			description:
				"Whether to send session-affinity data from options.sessionId. Default: true for OpenRouter endpoints, false otherwise.",
		}),
		sessionAffinityFormat: optionalSessionAffinityFormat({
			description:
				"Session-affinity header format. openai sends session_id, x-client-request-id, and x-session-affinity; openai-nosession sends x-client-request-id and x-session-affinity; openrouter sends x-session-id. Does not affect prompt_cache_key. Default: auto-detected.",
		}),
		supportsLongCacheRetention: optionalCompatBoolean({
			description:
				'Whether the provider supports long prompt cache retention (prompt_cache_retention: "24h" or Anthropic-style cache_control.ttl: "1h", depending on format). Default: auto-detected from provider and URL.',
		}),
		supportsExplicitPromptCacheMode: Type.Optional(
			Type.Boolean({
				description:
					"Whether the model is GPT-5.6 or later, which replaces prompt_cache_retention with prompt_cache_options. Chat Completions then sends no long-retention field. The generated catalog sets it for verified models; unset means false.",
				default: false,
			}),
		),
		vllmPriority: Type.Optional(
			Type.Number({
				description:
					"vLLM scheduler priority sent as the top-level priority request field. Lower values are handled earlier and the server default is 0. Only meaningful with --scheduling-policy priority. Off by default and not set on the generated catalog.",
			}),
		),
		toolSchemaFlavor: Type.Optional(
			Type.Union([Type.Literal("standard"), Type.Literal("moonshot")], {
				description:
					'Tool declaration format for Chat Completions. Moonshot endpoints and Kimi model IDs use "moonshot", including through gateways. It projects object alternatives and represents scalar choices with enums. Set "standard" to send the authored JSON Schema. Local validation uses the original tool contract.',
			}),
		),
	},
	{
		description:
			"Compatibility settings for OpenAI-compatible completions APIs. Use this to override URL-based auto-detection for custom providers.",
		additionalProperties: true,
	},
);

export const OpenAIResponsesCompatSchema = Type.Object(
	{
		supportsDeveloperRole: optionalCompatBoolean({
			description: "Whether the provider supports the developer role instead of system.",
			default: true,
		}),
		supportsMidConvoSystemMessages: optionalCompatBoolean({
			description:
				"Whether the exact model accepts developer or system messages after the conversation has started. When false, the leading system message stays unchanged and later system messages are sent as marked user messages. The generated catalog enables this for verified models.",
			default: false,
		}),
		sessionAffinityFormat: optionalSessionAffinityFormat({
			description:
				"Session-affinity header format. openai sends session_id and x-client-request-id; openai-nosession sends x-client-request-id; openrouter sends x-session-id. Does not affect prompt_cache_key. Default: auto-detected.",
		}),
		supportsLongCacheRetention: optionalCompatBoolean({
			description:
				'Whether the provider supports long prompt cache retention. This uses prompt_cache_options.ttl: "12h" for long history on GPT-5.6+ and prompt_cache_retention: "24h" on earlier models. Default: true on OpenAI\'s API for GPT-5.6+ in explicit cache mode and for the models OpenAI lists for 24h retention; false elsewhere.',
		}),
		supportsTemperature: optionalCompatBoolean({
			description: "Whether the model accepts the temperature request field. When false, temperature is omitted.",
			default: true,
		}),
		supportsStrictMode: optionalCompatBoolean({
			description:
				"Whether the provider supports strict JSON-schema function tools. Defaults are API-specific; generated OpenAI models enable it explicitly.",
		}),
		supportsOpenAIGrammarTools: optionalCompatBoolean({
			description:
				"Whether to emit OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools. The generated catalog enables this for capable models.",
			default: false,
		}),
		supportsAdditionalTools: Type.Optional(
			Type.Boolean({
				description: "Whether the model supports message-anchored additional_tools input items.",
				default: false,
			}),
		),
		supportsToolSearch: Type.Optional(
			Type.Boolean({
				description: "Whether the model supports client-executed tool search for transcript-anchored additions.",
				default: false,
			}),
		),
		supportsExplicitPromptCacheMode: Type.Optional(
			Type.Boolean({
				description: "Whether the model accepts prompt_cache_options. Older OpenAI models reject the parameter.",
				default: false,
			}),
		),
		supportsInstructionBreakpoints: optionalCompatBoolean({
			description:
				"Whether the model takes 30m prompt cache breakpoints on its leading instructions without explicit cache mode (Azure deployments of GPT-6 Astra). The generated catalog sets it for verified models; unset means false.",
			default: false,
		}),
		supportsMidConvoEffort: Type.Optional(
			Type.Boolean({
				description:
					"Whether thinking level changes are sent as configuration_update input items instead of changing reasoning.effort, so a change keeps the prompt cache. Only used by the openai-responses API, and ignored with Sign in with ChatGPT on the openai provider.",
				default: false,
			}),
		),
		supportsMaxOutputTokens: Type.Optional(
			Type.Boolean({
				description: "Whether the provider accepts max_output_tokens. Some Codex-protocol gateways reject it.",
				default: true,
			}),
		),
	},
	{ description: "Compatibility settings for OpenAI Responses APIs.", additionalProperties: true },
);
