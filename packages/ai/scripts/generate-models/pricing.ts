import type { Api, Model, ModelCost } from "../../src/types.ts";
import { OPENAI_LONG_CONTEXT_INPUT_THRESHOLD } from "./constants.ts";
import type { ModelsDevModel } from "./types.ts";

/** Cost conversion from upstream catalogs, and OpenAI's long-context pricing tier. */

export function withOpenAiLongContextPricing(cost: Model<Api>["cost"]): Model<Api>["cost"] {
	return {
		...cost,
		tiers: [
			{
				inputTokensAbove: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
				input: roundCost(cost.input * 2),
				output: roundCost(cost.output * 1.5),
				cacheRead: roundCost(cost.cacheRead * 2),
				cacheWrite: roundCost(cost.cacheWrite * 2),
			},
		],
	};
}

export function roundCost(value: number): number {
	return Number(value.toFixed(6));
}

export function getModelsDevCost(cost: ModelsDevModel["cost"]): ModelCost {
	const base = {
		input: cost?.input ?? 0,
		output: cost?.output ?? 0,
		cacheRead: cost?.cache_read ?? 0,
		cacheWrite: cost?.cache_write ?? 0,
	};
	// Rates a tier does not list keep the base price.
	const tiers = cost?.tiers?.flatMap((tier) => {
		const context = tier.tier;
		if (context?.type !== "context" || context.size === undefined) return [];
		return [
			{
				inputTokensAbove: context.size,
				input: tier.input ?? base.input,
				output: tier.output ?? base.output,
				cacheRead: tier.cache_read ?? base.cacheRead,
				cacheWrite: tier.cache_write ?? base.cacheWrite,
			},
		];
	});

	return tiers && tiers.length > 0 ? { ...base, tiers } : base;
}
