import { type Static, type TSchemaOptions, Type } from "typebox";
import { PROVIDER_PROFILE_IDS } from "../types/profile.ts";

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
const MODEL_THINKING_LEVELS = ["off", ...THINKING_LEVELS] as const;
const MODEL_INPUT_MODALITIES = ["text", "image"] as const;
export const CACHE_RETENTIONS = ["none", "short", "long"] as const;
const MODEL_PROMPT_CACHE_RETENTIONS = ["short", "long"] as const;

const ThinkingLevelSchema = Type.Enum(THINKING_LEVELS);
/** The provider profile a models.json provider names: the cache facts and request-format quirks its models follow. */
export const ProviderProfileSchema = Type.Enum(PROVIDER_PROFILE_IDS, {
	description:
		"The provider family whose cache markers, cache lifetimes and request quirks this provider's models follow: use it for a gateway that serves another provider's models (a Claude gateway takes \"anthropic\"). Unset: detected from the provider id and host. An explicit compat value still wins.",
});
export const ModelThinkingLevelSchema = Type.Enum(MODEL_THINKING_LEVELS);
export const ModelInputModalitySchema = Type.Enum(MODEL_INPUT_MODALITIES);
const CacheRetentionSchema = Type.Enum(CACHE_RETENTIONS);

const ThinkingLevelMapValueSchema = Type.Union([Type.String(), Type.Null()]);
export const ThinkingLevelMapSchema = Type.Partial(Type.Record(ModelThinkingLevelSchema, ThinkingLevelMapValueSchema), {
	description:
		"Provider value sent for each thinking level. null marks a level unsupported. Levels the model does not map use the provider's default value through high; xhigh and max are unsupported.",
});

export const ModelPromptCacheSchema = Type.Partial(
	Type.Record(Type.Enum(MODEL_PROMPT_CACHE_RETENTIONS), Type.Number({ exclusiveMinimum: 0 })),
	{
		description:
			"Best-effort prompt cache lifetime in seconds for the short and long retention tiers. Octocode warms only tiers with a known lifetime.",
	},
);

const ModelCostRatesProperties = {
	input: Type.Number({ description: "Input cost in USD per million tokens." }),
	output: Type.Number({ description: "Output cost in USD per million tokens." }),
	cacheRead: Type.Number({ description: "Cache-read cost in USD per million tokens." }),
	cacheWrite: Type.Number({ description: "Cache-write cost in USD per million tokens." }),
};

const ModelCostRatesSchema = Type.Object(ModelCostRatesProperties);
const ModelCostTierSchema = Type.Object({
	inputTokensAbove: Type.Number({
		description: "Use this tier when total request input exceeds this token count.",
	}),
	...ModelCostRatesProperties,
});
const ModelCostTiersProperty = Type.Optional(
	Type.Array(ModelCostTierSchema, {
		description: "Request-wide pricing tiers. The highest matching input threshold applies to the full request.",
	}),
);
/** Rates that replace a time-limited price once it ends. They cannot expire themselves. */
const ModelCostAfterSchema = Type.Object(
	{ ...ModelCostRatesProperties, tiers: ModelCostTiersProperty },
	{ description: "Rates (and tiers) charged from the day after `until`." },
);
export const ModelCostSchema = Type.Object({
	...ModelCostRatesProperties,
	tiers: ModelCostTiersProperty,
	until: Type.Optional(
		Type.String({
			pattern: "^\\d{4}-\\d{2}-\\d{2}$",
			description:
				"Last UTC day (YYYY-MM-DD, inclusive) these rates apply, for a time-limited price. Ignored without `after`.",
		}),
	),
	after: Type.Optional(ModelCostAfterSchema),
});

function modelImageResizeOptions(options?: TSchemaOptions) {
	return Type.Object(
		{
			maxWidth: Type.Optional(Type.Integer({ minimum: 1 })),
			maxHeight: Type.Optional(Type.Integer({ minimum: 1 })),
			maxBytes: Type.Optional(
				Type.Integer({ minimum: 1, description: "Maximum base64-encoded payload size in bytes." }),
			),
			jpegQuality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		},
		options,
	);
}

const ModelImageResizeOptionsSchema = modelImageResizeOptions();

const ModelImageInputLimitsSchema = Type.Object({
	resize: Type.Optional(
		modelImageResizeOptions({
			description: "Cache-safe resize profile applied before a new image enters conversation history.",
		}),
	),
	maxPerMessage: Type.Optional(
		Type.Integer({ minimum: 1, description: "Maximum images accepted in one provider message." }),
	),
	maxPerRequest: Type.Optional(
		Type.Integer({ minimum: 1, description: "Maximum images accepted across one provider request." }),
	),
});

export const ModelInputLimitsSchema = Type.Object({
	maxInputTokens: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Maximum prompt tokens accepted independently of the combined context window.",
		}),
	),
	maxRequestBytes: Type.Optional(
		Type.Integer({ minimum: 1, description: "Maximum serialized provider request size in bytes." }),
	),
	images: Type.Optional(ModelImageInputLimitsSchema),
});

export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
export type ModelThinkingLevel = Static<typeof ModelThinkingLevelSchema>;
export type ThinkingLevelMap = Static<typeof ThinkingLevelMapSchema>;
export type ModelInputModality = Static<typeof ModelInputModalitySchema>;
export type CacheRetention = Static<typeof CacheRetentionSchema>;
export type ModelPromptCache = Static<typeof ModelPromptCacheSchema>;
export type ModelCostRates = Static<typeof ModelCostRatesSchema>;
export type ModelCostTier = Static<typeof ModelCostTierSchema>;
export type ModelCost = Static<typeof ModelCostSchema>;
export type ModelImageResizeOptions = Static<typeof ModelImageResizeOptionsSchema>;
export type ModelImageInputLimits = Static<typeof ModelImageInputLimitsSchema>;
export type ModelInputLimits = Static<typeof ModelInputLimitsSchema>;
