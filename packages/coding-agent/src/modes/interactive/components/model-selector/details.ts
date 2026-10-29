import type { Model } from "@octocodeai/octocode-ai";

/** Catalog estimates belong to the selected provider; account billing and service tiers may differ. */
export function modelDetails(model: Model<any>): string {
	const rate = (value: number) => (Number.isFinite(value) && value >= 0 ? `$${value}` : "unknown");
	const cost = model.cost;
	const cache = model.promptCache
		? Object.entries(model.promptCache)
				.map(([tier, seconds]) => `${tier} ${seconds}s`)
				.join(", ")
		: "lifetime unspecified";
	return [
		`Model Name: ${model.name}`,
		`Image input: ${model.input.includes("image") ? "supported" : "not configured"}`,
		`Context ${model.contextWindow.toLocaleString("en-US")} · Max output ${model.maxTokens.toLocaleString("en-US")} · Thinking ${model.reasoning ? "supported (/effort)" : "unavailable"}`,
		`Catalog base USD/M tokens: input ${rate(cost.input)} · output ${rate(cost.output)} · cache read ${rate(cost.cacheRead)} · cache write ${rate(cost.cacheWrite)}`,
		`Cache: ${cache}${cost.tiers?.length ? ` · Pricing tiers above ${cost.tiers.map((tier) => tier.inputTokensAbove.toLocaleString("en-US")).join(" / ")} input tokens` : ""}. Account and service-tier billing may differ.`,
	]
		.map((line) => `  ${line}`)
		.join("\n");
}
