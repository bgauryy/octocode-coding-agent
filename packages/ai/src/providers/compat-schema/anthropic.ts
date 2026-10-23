import { Type } from "typebox";
import { ModelCostSchema } from "../model-schema.ts";
import { optionalCompatBoolean } from "./common.ts";

export const AnthropicAllowedFallbackModelSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1 }),
		model: Type.String({ minLength: 1 }),
		cost: ModelCostSchema,
	},
	{ description: "An Anthropic server-side refusal fallback model with local pricing metadata." },
);

export const AnthropicMessagesCompatSchema = Type.Object(
	{
		supportsEagerToolInputStreaming: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider accepts per-tool eager_input_streaming. When false, the Anthropic provider omits tools[].eager_input_streaming and sends the legacy fine-grained-tool-streaming-2025-05-14 beta header for tool-enabled requests.",
				default: true,
			}),
		),
		supportsLongCacheRetention: optionalCompatBoolean({
			description: "Whether the provider supports Anthropic long cache retention through cache_control.ttl.",
			default: true,
		}),
		sendSessionAffinityHeaders: optionalCompatBoolean({
			description:
				"Whether to send x-session-affinity from options.sessionId when caching is enabled. Required for providers like Fireworks that use session affinity for prompt cache routing; requests to the same replica maximize cache hits. Default: true for OpenRouter endpoints, false otherwise.",
		}),
		sessionAffinityFormat: Type.Optional(
			Type.Literal("openrouter", {
				description: "Session-affinity format. openrouter sends x-session-id; when unset, sends x-session-affinity.",
			}),
		),
		supportsCacheControlOnTools: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider supports Anthropic-style cache_control markers on tool definitions. When false, cache_control is omitted from tool parameters. Some Anthropic-compatible providers, such as Fireworks, do not support this field on tools and may reject or ignore it.",
				default: true,
			}),
		),
		supportsTemperature: Type.Optional(
			Type.Boolean({
				description:
					"Whether the model accepts the Anthropic temperature request field. Claude Opus 4.7+ rejects non-default values.",
				default: true,
			}),
		),
		forceAdaptiveThinking: Type.Optional(
			Type.Boolean({
				description:
					"Whether to force adaptive thinking (thinking.type: adaptive plus output_config.effort) regardless of model ID. Built-in models that require adaptive thinking set this in generated metadata. Custom Anthropic-compatible providers can set this to true for any model whose upstream requires the adaptive format. Set false to opt out on overridden built-in models.",
				default: false,
			}),
		),
		allowEmptySignature: Type.Optional(
			Type.Boolean({
				description: "Whether to replay empty thinking signatures instead of converting thinking to text.",
				default: false,
			}),
		),
		supportsStrictTools: Type.Optional(
			Type.Boolean({
				description:
					"Whether the provider supports Anthropic strict tool schemas. Generated Anthropic models enable it explicitly.",
				default: false,
			}),
		),
		supportsMidConvoEffort: Type.Optional(
			Type.Boolean({
				description:
					"Whether the exact model transport supports effort-only system messages and thinking binding controls.",
				default: false,
			}),
		),
		supportsMidConvoSystemMessages: optionalCompatBoolean({
			description:
				"Whether the exact model accepts system-role messages inside the conversation. When false, later system messages are folded into the top-level system prompt.",
			default: false,
		}),
		supportsMidConvoToolChanges: Type.Optional(
			Type.Boolean({
				description:
					"Whether the exact model accepts mid-conversation tool_addition and tool_removal blocks. Requires supportsMidConvoSystemMessages.",
				default: false,
			}),
		),
		allowedFallbackModels: Type.Optional(
			Type.Array(AnthropicAllowedFallbackModelSchema, {
				maxItems: 3,
				description:
					"Models Anthropic accepts for server-side refusal fallback, with local pricing metadata for returned fallback responses. When absent or empty, callers must omit fallbacks; Anthropic rejects the field for models with no permitted fallback targets.",
			}),
		),
	},
	{ description: "Compatibility settings for Anthropic Messages-compatible APIs.", additionalProperties: true },
);
