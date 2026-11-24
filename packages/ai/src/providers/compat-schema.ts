import { type Static, type TProperties, Type } from "typebox";
import { type AnthropicAllowedFallbackModelSchema, AnthropicMessagesCompatSchema } from "./compat-schema/anthropic.ts";
import {
	type ChatTemplateKwargValueSchema,
	type OpenRouterRoutingSchema,
	optionalCompatBoolean,
	optionalSessionAffinityFormat,
	type SessionAffinityFormatSchema,
	type ThinkingTokenBudgetFieldSchema,
	VercelGatewayRoutingSchema,
} from "./compat-schema/common.ts";
import { OpenAICompletionsCompatSchema, OpenAIResponsesCompatSchema } from "./compat-schema/openai.ts";

export const BedrockCompatSchema = Type.Object(
	{
		supportsStrictMode: optionalCompatBoolean({
			description: "Whether the model supports Bedrock strict tool schemas.",
			default: false,
		}),
		supportsLongCacheRetention: optionalCompatBoolean({
			description:
				'Whether cacheRetention "long" sends one-hour cache points. Set false for models or regions that reject the ttl field.',
			default: true,
		}),
	},
	{ description: "Compatibility settings for Amazon Bedrock models.", additionalProperties: true },
);

const MistralConversationsCompatSchema = Type.Object(
	{
		supportsMidConvoSystemMessages: optionalCompatBoolean({
			description:
				"Whether the exact model accepts system messages after the conversation has started. When false, the leading system message stays unchanged and later system messages are sent as marked user messages.",
			default: false,
		}),
		supportsTemperature: optionalCompatBoolean({
			description: "Whether the model accepts the temperature request field. When false, temperature is omitted.",
			default: true,
		}),
		supportsStrictMode: optionalCompatBoolean({
			description:
				"Whether the model accepts the strict field in tool definitions. When false, tools are sent without it.",
			default: true,
		}),
	},
	{ description: "Compatibility settings for the Mistral chat API.", additionalProperties: true },
);

const GoogleCompatSchema = Type.Object(
	{
		supportsTemperature: optionalCompatBoolean({
			description: "Whether the model accepts the temperature request field. When false, temperature is omitted.",
			default: true,
		}),
	},
	{ description: "Compatibility settings for Gemini models.", additionalProperties: true },
);

const ProviderCompatPropertyOverrides = {
	vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
	supportsDeveloperRole: optionalCompatBoolean({
		description: "Whether the provider supports the developer role instead of system. Defaults are API-specific.",
	}),
	supportsMidConvoSystemMessages: optionalCompatBoolean({
		description:
			"Whether the exact model accepts system or developer messages after the conversation has started. When false, the leading system message stays unchanged and later system messages are sent as marked user messages.",
		default: false,
	}),
	sessionAffinityFormat: optionalSessionAffinityFormat({
		description: "Session-affinity header format. Defaults are API-specific or auto-detected.",
	}),
	supportsExplicitPromptCacheMode: optionalCompatBoolean({
		description:
			"Whether the model accepts prompt_cache_options (GPT-5.6 and later) instead of prompt_cache_retention. Older OpenAI models reject the parameter. The generated catalog sets it for verified models; unset means false.",
		default: false,
	}),
	supportsMidConvoEffort: optionalCompatBoolean({
		description:
			"Whether thinking level changes are sent inside the conversation instead of changing the request's effort, so a change keeps the prompt cache. Used by the anthropic-messages and openai-responses APIs.",
		default: false,
	}),
	supportsLongCacheRetention: optionalCompatBoolean({
		description:
			"Whether the provider supports long prompt cache retention. Defaults are API-specific or auto-detected.",
	}),
	supportsStrictMode: optionalCompatBoolean({
		description: "Whether the provider supports strict tool schemas. Defaults are API-specific.",
	}),
	supportsTemperature: optionalCompatBoolean({
		description: "Whether the model accepts the temperature request field. Default: true.",
	}),
	supportsOpenAIGrammarTools: optionalCompatBoolean({
		description:
			"Whether the provider supports OpenAI custom tools with Lark or regex grammar formats. When false, grammar-constrained tools fall back to normal function tools.",
		default: false,
	}),
	sendSessionAffinityHeaders: optionalCompatBoolean({
		description: "Whether to send session-affinity data from options.sessionId. Defaults are API-specific.",
	}),
} satisfies TProperties;

type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
	value: infer Intersection,
) => void
	? Intersection
	: never;

type MergedCompatProperties<PropertyGroups extends readonly TProperties[], Overrides extends TProperties> = Omit<
	UnionToIntersection<PropertyGroups[number]>,
	keyof Overrides
> &
	Overrides;

/**
 * Provider-level models.json compatibility is API-agnostic, so it needs one superset. Every
 * duplicate property requires explicit generic metadata, while API-specific schemas retain their
 * own defaults and descriptions.
 */
function mergeCompatProperties<
	const PropertyGroups extends readonly TProperties[],
	const Overrides extends TProperties,
>(propertyGroups: PropertyGroups, overrides: Overrides): MergedCompatProperties<PropertyGroups, Overrides> {
	const merged: TProperties = {};
	const duplicateNames = new Set<string>();

	for (const properties of propertyGroups) {
		for (const [name, schema] of Object.entries(properties)) {
			if (merged[name] !== undefined) {
				duplicateNames.add(name);
				if (!(name in overrides)) {
					throw new Error(`Duplicate compatibility schema property requires an override: ${name}`);
				}
			}
			merged[name] = schema;
		}
	}

	for (const name of Object.keys(overrides)) {
		if (!duplicateNames.has(name)) {
			throw new Error(`Compatibility schema override does not resolve a duplicate property: ${name}`);
		}
	}

	return { ...merged, ...overrides } as MergedCompatProperties<PropertyGroups, Overrides>;
}

/** Compatibility schema for each API whose models accept compat. Mirrors the compat type of Model. */
export const CompatSchemasByApi = {
	"openai-completions": OpenAICompletionsCompatSchema,
	"openai-responses": OpenAIResponsesCompatSchema,
	openresponses: OpenAIResponsesCompatSchema,
	"azure-openai-responses": OpenAIResponsesCompatSchema,
	"anthropic-messages": AnthropicMessagesCompatSchema,
	"bedrock-converse-stream": BedrockCompatSchema,
	"mistral-conversations": MistralConversationsCompatSchema,
	"google-generative-ai": GoogleCompatSchema,
	"google-vertex": GoogleCompatSchema,
} as const;

const ProviderCompatProperties = mergeCompatProperties(
	[...new Set(Object.values(CompatSchemasByApi))].map((schema) => schema.properties),
	ProviderCompatPropertyOverrides,
);

export const ProviderCompatSchema = Type.Object(ProviderCompatProperties, {
	description: "Provider and model compatibility overrides.",
	additionalProperties: true,
});

export type ChatTemplateKwargValue = Static<typeof ChatTemplateKwargValueSchema>;
/** Top-level request field used to cap reasoning tokens on OpenAI-compatible servers. */
export type ThinkingTokenBudgetField = Static<typeof ThinkingTokenBudgetFieldSchema>;
export type SessionAffinityFormat = Static<typeof SessionAffinityFormatSchema>;
export interface OpenRouterRouting extends Static<typeof OpenRouterRoutingSchema> {}
export interface VercelGatewayRouting extends Static<typeof VercelGatewayRoutingSchema> {}
/** An Anthropic server-side refusal fallback model with local pricing metadata. */
export interface AnthropicAllowedFallbackModel extends Static<typeof AnthropicAllowedFallbackModelSchema> {}

/** Compatibility settings for OpenAI-compatible completions APIs. */
export interface OpenAICompletionsCompat extends Static<typeof OpenAICompletionsCompatSchema> {}
/** Compatibility settings for OpenAI Responses APIs. */
export interface OpenAIResponsesCompat extends Static<typeof OpenAIResponsesCompatSchema> {}
/** Compatibility settings for Anthropic Messages-compatible APIs. */
export interface AnthropicMessagesCompat extends Static<typeof AnthropicMessagesCompatSchema> {}
/** Compatibility settings for Amazon Bedrock models. */
export interface BedrockCompat extends Static<typeof BedrockCompatSchema> {}
/** Compatibility settings for Gemini models on the Generative AI and Vertex APIs. */
export interface GoogleCompat extends Static<typeof GoogleCompatSchema> {}
/** Compatibility settings for the Mistral chat API. */
export interface MistralConversationsCompat extends Static<typeof MistralConversationsCompatSchema> {}
