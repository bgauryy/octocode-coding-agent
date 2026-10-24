import type { Api, Model } from "../types.ts";

/** Fill omitted long-context rates in standard Vertex catalog entries. Explicit catalog tiers win. */
export function withGoogleVertexPricing<T extends Model<Api>>(model: T): T {
	if (model.provider !== "google-vertex" || model.api !== "google-vertex" || model.cost.tiers?.length) {
		return model;
	}
	const { cost } = model;
	// Restrict the correction to the published standard rates, preserving custom and future pricing.
	// https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing
	const expected =
		model.id === "gemini-2.5-pro"
			? { input: 1.25, output: 10, cacheRead: 0.125 }
			: model.id === "gemini-3.1-pro-preview"
				? { input: 2, output: 12, cacheRead: 0.2 }
				: undefined;
	if (
		!expected ||
		cost.input !== expected.input ||
		cost.output !== expected.output ||
		cost.cacheRead !== expected.cacheRead ||
		cost.cacheWrite !== 0
	) {
		return model;
	}
	return {
		...model,
		cost: {
			...cost,
			tiers: [
				{
					inputTokensAbove: 200_000,
					input: cost.input * 2,
					output: cost.output * 1.5,
					cacheRead: cost.cacheRead * 2,
					cacheWrite: 0,
				},
			],
		},
	};
}
