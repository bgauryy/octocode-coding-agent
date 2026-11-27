import type { Usage } from "../../types.ts";

/** The OpenRouter `usage` fields that carry billed cost, in USD credits. */
export interface OpenRouterUsageCost {
	cost?: unknown;
	is_byok?: unknown;
	cost_details?: {
		upstream_inference_cost?: unknown;
		upstream_inference_prompt_cost?: unknown;
		upstream_inference_completions_cost?: unknown;
	} | null;
}

/** A finite, non-negative USD amount from a JSON number or numeric string; anything else is "not reported". */
export function safeUsd(value: unknown): number | undefined {
	const amount = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	return typeof amount === "number" && Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

/**
 * The USD the endpoint reports charging for the request, or undefined so the caller prices tokens from the catalog.
 * A BYOK request is billed twice over: `cost` is OpenRouter's fee and `upstream_inference_cost` what the provider
 * charged the caller's own key, so both count.
 */
export function reportedCostUsd(raw: OpenRouterUsageCost): number | undefined {
	const charged = safeUsd(raw.cost);
	if (charged === undefined) return undefined;
	if (raw.is_byok !== true) return charged;
	return charged + (safeUsd(raw.cost_details?.upstream_inference_cost) ?? 0);
}

/**
 * Replaces the static token-rate cost with the reported total. The total is exact; the buckets split it by the best
 * available weights (catalog rates, then the upstream prompt/completion split, then token counts) so they still sum
 * to it. The token buckets are untouched.
 */
export function applyReportedCost(usage: Usage, raw: OpenRouterUsageCost, total: number): void {
	const details = raw.cost_details;
	const prompt = safeUsd(details?.upstream_inference_prompt_cost) ?? 0;
	const completions = safeUsd(details?.upstream_inference_completions_cost) ?? 0;
	const staticCost = usage.cost;
	const weights =
		staticCost.total > 0
			? {
					input: staticCost.input,
					output: staticCost.output,
					cacheRead: staticCost.cacheRead,
					cacheWrite: staticCost.cacheWrite,
				}
			: prompt + completions > 0
				? { input: prompt, output: completions, cacheRead: 0, cacheWrite: 0 }
				: {
						input: usage.input + usage.cacheRead + usage.cacheWrite,
						output: usage.output,
						cacheRead: 0,
						cacheWrite: 0,
					};
	const sum = weights.input + weights.output + weights.cacheRead + weights.cacheWrite;
	if (sum <= 0) {
		usage.cost = { input: 0, output: total, cacheRead: 0, cacheWrite: 0, total };
		return;
	}
	const scale = total / sum;
	usage.cost = {
		input: weights.input * scale,
		output: weights.output * scale,
		cacheRead: weights.cacheRead * scale,
		cacheWrite: weights.cacheWrite * scale,
		total,
	};
}
