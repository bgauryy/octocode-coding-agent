import type { Api, AnyModel, Model, ModelCost, ModelCostRates, Usage } from "../types.ts";
import { getModelType, isModelType } from "../utils/model-operations.ts";

/**
 * Runtime-checked narrowing for dynamically looked-up models:
 *
 * ```ts
 * const model = models.getModel("anthropic", "claude-opus-4-7");
 * if (model && hasApi(model, "anthropic-messages")) {
 *   // model: Model<"anthropic-messages">, stream options fully typed
 * }
 * ```
 *
 * Non-chat models never match, even when their api id equals `api`.
 */
export function hasApi<TApi extends Api>(model: AnyModel, api: TApi): model is Model<TApi> {
	return isModelType(model, "chat") && model.api === api;
}

/** `Usage.cacheWrite1h` price over the input rate: Anthropic (direct and Bedrock) 1-hour writes. */
const CACHE_WRITE_1H_INPUT_MULTIPLIER = 2;
/** `Usage.cacheWrite12h` price over the input rate: OpenAI explicit 12-hour writes. */
const CACHE_WRITE_12H_INPUT_MULTIPLIER = 2.5;

const MS_PER_DAY = 86_400_000;

/**
 * The rates (and context tiers) in force at `now`: the listed ones, or `after` once the UTC day `until` has ended.
 * Every reader of a model price, for pricing or display, goes through this one rule.
 * An entry without `after`, or with an unreadable `until`, never expires.
 */
export function activeRates(
	cost: ModelCost,
	now: Date | number = Date.now(),
): ModelCostRates & Pick<ModelCost, "tiers"> {
	if (!cost.after || cost.until === undefined) return cost;
	const lastDay = Date.parse(`${cost.until}T00:00:00Z`);
	return Number.isNaN(lastDay) || +now < lastDay + MS_PER_DAY ? cost : cost.after;
}

/**
 * Prices `usage` at the model's catalog rates. `now` selects between the listed and the `after` rates of a
 * time-limited price; tests inject it, callers normally take the system clock.
 */
export function calculateCost(model: AnyModel, usage: Usage, now: Date | number = Date.now()): Usage["cost"] {
	const cost = activeRates(model.cost, now);
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	let rates: ModelCostRates = cost;
	let matchedThreshold = -1;
	for (const tier of cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}

	// Long writes are disjoint subsets of the aggregate, never additional tokens. A model without a cache-write rate
	// charges no write premium (OpenAI before explicit caching), so its long writes cost what its short writes cost.
	const premium = rates.cacheWrite > 0;
	const longRate = premium ? rates.input * CACHE_WRITE_1H_INPUT_MULTIPLIER : rates.cacheWrite;
	const extendedRate = premium ? rates.input * CACHE_WRITE_12H_INPUT_MULTIPLIER : rates.cacheWrite;
	const longWrite = usage.cacheWrite1h ?? 0;
	const extendedWrite = usage.cacheWrite12h ?? 0;
	const shortWrite = Math.max(0, usage.cacheWrite - longWrite - extendedWrite);
	usage.cost.input = (rates.input / 1000000) * usage.input;
	usage.cost.output = (rates.output / 1000000) * usage.output;
	usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite =
		(rates.cacheWrite * shortWrite + longRate * longWrite + extendedRate * extendedWrite) / 1000000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

export { clampThinkingLevel, effortLevel, effortValue, getSupportedThinkingLevels } from "./thinking.ts";

/**
 * Check if two models are equal by comparing their type, id, and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual(a: AnyModel | null | undefined, b: AnyModel | null | undefined): boolean {
	if (!a || !b) return false;
	return getModelType(a) === getModelType(b) && a.id === b.id && a.provider === b.provider;
}
