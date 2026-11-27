import type { Api, Model } from "../../src/types.ts";
import { OPENAI_LONG_CONTEXT_INPUT_THRESHOLD } from "./constants.ts";

/** Cost rounding for upstream catalogs, and OpenAI's long-context pricing tier. (models.dev prices: `src/catalog/models-dev-fields.ts`.) */

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
