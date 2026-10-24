import { type TSchemaOptions, Type } from "typebox";

function sessionAffinityFormat(options?: TSchemaOptions) {
	return Type.Union([Type.Literal("openai"), Type.Literal("openai-nosession"), Type.Literal("openrouter")], options);
}

export const SessionAffinityFormatSchema = sessionAffinityFormat({
	description: "Session-affinity header format used to route related requests consistently.",
});

export function thinkingTokenBudgetField(options?: TSchemaOptions) {
	return Type.Union(
		[Type.Literal("thinking_token_budget"), Type.Literal("thinking_budget"), Type.Literal("thinking_budget_tokens")],
		options,
	);
}

export const ThinkingTokenBudgetFieldSchema = thinkingTokenBudgetField({
	description:
		'Top-level request field name used by OpenAI-compatible endpoints to cap reasoning tokens. "thinking_token_budget" is used by vLLM, "thinking_budget" by Qwen, DashScope, or SGLang, and "thinking_budget_tokens" by llama.cpp.',
});

export const ChatTemplateKwargValueSchema = Type.Union([
	Type.String(),
	Type.Number(),
	Type.Boolean(),
	Type.Null(),
	Type.Object({
		$var: Type.Union([
			Type.Literal("thinking.enabled"),
			Type.Literal("thinking.effort"),
			Type.Literal("thinking.budget"),
		]),
		omitWhenOff: Type.Optional(Type.Boolean()),
	}),
]);

function percentileCutoffs(metric: string) {
	return Type.Object({
		p50: Type.Optional(Type.Number({ description: `${metric} at the 50th percentile.` })),
		p75: Type.Optional(Type.Number({ description: `${metric} at the 75th percentile.` })),
		p90: Type.Optional(Type.Number({ description: `${metric} at the 90th percentile.` })),
		p99: Type.Optional(Type.Number({ description: `${metric} at the 99th percentile.` })),
	});
}

export const OpenRouterRoutingSchema = Type.Object(
	{
		allow_fallbacks: Type.Optional(
			Type.Boolean({ description: "Whether to allow backup providers to serve requests.", default: true }),
		),
		require_parameters: Type.Optional(
			Type.Boolean({
				description: "Whether to filter providers to only those that support all parameters in the request.",
				default: false,
			}),
		),
		data_collection: Type.Optional(
			Type.Union([Type.Literal("deny"), Type.Literal("allow")], {
				description:
					'Data collection setting. "allow": allow providers that may store or train on data. "deny": only use providers that do not collect user data.',
				default: "allow",
			}),
		),
		zdr: Type.Optional(
			Type.Boolean({ description: "Whether to restrict routing to only ZDR (Zero Data Retention) endpoints." }),
		),
		enforce_distillable_text: Type.Optional(
			Type.Boolean({ description: "Whether to restrict routing to only models that allow text distillation." }),
		),
		order: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"An ordered list of provider names or slugs to try in sequence, falling back to the next if unavailable.",
			}),
		),
		only: Type.Optional(
			Type.Array(Type.String(), {
				description: "List of provider names or slugs to exclusively allow for this request.",
			}),
		),
		ignore: Type.Optional(
			Type.Array(Type.String(), { description: "List of provider names or slugs to skip for this request." }),
		),
		quantizations: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'A list of quantization levels to filter providers by, for example ["fp16", "bf16", "fp8", "fp6", "int8", "int4", "fp4", "fp32"].',
			}),
		),
		sort: Type.Optional(
			Type.Union(
				[
					Type.String(),
					Type.Object({
						by: Type.Optional(
							Type.String({ description: 'The sorting metric, such as "price", "throughput", or "latency".' }),
						),
						partition: Type.Optional(
							Type.Union([Type.String(), Type.Null()], {
								description: 'Partitioning strategy: "model" or "none".',
								default: "model",
							}),
						),
					}),
				],
				{
					description: 'Sorting strategy. Can be a string such as "price", "throughput", or "latency", or an object.',
				},
			),
		),
		max_price: Type.Optional(
			Type.Object(
				{
					prompt: Type.Optional(
						Type.Union([Type.Number(), Type.String()], { description: "Price per million prompt tokens." }),
					),
					completion: Type.Optional(
						Type.Union([Type.Number(), Type.String()], { description: "Price per million completion tokens." }),
					),
					image: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Price per image." })),
					audio: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Price per audio unit." })),
					request: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Price per request." })),
				},
				{ description: "Maximum price per million tokens in USD." },
			),
		),
		preferred_min_throughput: Type.Optional(
			Type.Union([Type.Number(), percentileCutoffs("Minimum tokens per second")], {
				description: "Preferred minimum throughput in tokens per second. A number applies to p50.",
			}),
		),
		preferred_max_latency: Type.Optional(
			Type.Union([Type.Number(), percentileCutoffs("Maximum latency in seconds")], {
				description: "Preferred maximum latency in seconds. A number applies to p50.",
			}),
		),
	},
	{
		description:
			"OpenRouter provider routing preferences. Controls which upstream providers OpenRouter routes requests to. Sent as the provider field in the OpenRouter API request body. See https://openrouter.ai/docs/guides/routing/provider-selection.",
	},
);

export const VercelGatewayRoutingSchema = Type.Object(
	{
		only: Type.Optional(
			Type.Array(Type.String(), {
				description:
					'List of provider slugs to exclusively use for this request, for example ["bedrock", "anthropic"].',
			}),
		),
		order: Type.Optional(
			Type.Array(Type.String(), {
				description: 'List of provider slugs to try in order, for example ["anthropic", "openai"].',
			}),
		),
	},
	{
		description:
			"Vercel AI Gateway routing preferences. Controls which upstream providers the gateway routes requests to. See https://vercel.com/docs/ai-gateway/models-and-providers/provider-options.",
	},
);
export function optionalCompatBoolean(options?: TSchemaOptions) {
	return Type.Optional(Type.Boolean(options));
}

export function optionalSessionAffinityFormat(options?: TSchemaOptions) {
	return Type.Optional(sessionAffinityFormat(options));
}
