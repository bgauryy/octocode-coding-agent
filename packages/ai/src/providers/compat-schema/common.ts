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

const providerSlugs = (description: string) =>
	Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description }));

export const VercelGatewayRoutingSchema = Type.Object(
	{
		only: providerSlugs(
			'List of provider slugs to exclusively use for this request, for example ["bedrock", "anthropic"].',
		),
		order: providerSlugs('List of provider slugs to try in order, for example ["anthropic", "openai"].'),
		models: providerSlugs(
			'Fallback model ids the gateway tries when the primary model fails, for example ["openai/gpt-5.1"].',
		),
		sort: Type.Optional(
			Type.Union([Type.Literal("cost"), Type.Literal("ttft"), Type.Literal("tps")], {
				description: "Rank providers by cost, time to first token (ttft) or throughput (tps).",
			}),
		),
		headquarters: providerSlugs(
			'ISO 3166-1 alpha-2 country codes of provider headquarters to route to; prefix every code with "!" to exclude instead. A list cannot mix both forms.',
		),
		caching: Type.Optional(
			Type.Literal("auto", { description: "Let the gateway apply the provider's caching strategy." }),
		),
		zeroDataRetention: Type.Optional(
			Type.Boolean({ description: "Route only to providers with zero data retention for this request." }),
		),
		disallowPromptTraining: Type.Optional(
			Type.Boolean({ description: "Route only to providers that do not train on prompt data." }),
		),
		sessionAffinity: Type.Optional(
			Type.Boolean({
				description: "Whether the gateway pins a session to the provider holding its prompt cache. Default: true.",
			}),
		),
		providerTimeouts: Type.Optional(
			Type.Object(
				{
					byok: Type.Record(Type.String({ minLength: 1 }), Type.Integer({ minimum: 1 }), {
						description: "Milliseconds to wait for a BYOK provider to start responding, by provider slug.",
					}),
				},
				{ description: "Per-provider failover timeouts. Apply to BYOK credentials only." },
			),
		),
	},
	{
		description:
			"Vercel AI Gateway routing preferences, sent as providerOptions.gateway on Chat Completions and Anthropic Messages requests. See https://vercel.com/docs/ai-gateway/models-and-providers/provider-options.",
	},
);

export const OpenRouterAutoRouterSchema = Type.Object(
	{
		allowed_models: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				description: 'Hard allow list of model patterns, for example ["anthropic/*", "openai/gpt-5.1"].',
			}),
		),
		excluded_models: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				description: "Model patterns the router never selects. Applied after allowed_models.",
			}),
		),
		cost_tier: Type.Optional(
			Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
				description: "Routing policy: low favors cost, medium balances, high favors capability.",
			}),
		),
		metadata: Type.Optional(
			Type.Boolean({
				description:
					"Request router metadata (X-OpenRouter-Metadata) and record a sanitized summary as an assistant diagnostic. Default: true for openrouter/auto.",
			}),
		),
	},
	{
		description:
			"OpenRouter Auto Router plugin controls for openrouter/auto and openrouter/auto-beta, sent as an auto-router plugin entry. See https://openrouter.ai/docs/guides/routing/routers/auto-router.",
	},
);
export function optionalCompatBoolean(options?: TSchemaOptions) {
	return Type.Optional(Type.Boolean(options));
}

export function optionalSessionAffinityFormat(options?: TSchemaOptions) {
	return Type.Optional(sessionAffinityFormat(options));
}
