import { activeRates, type Model } from "@octocodeai/octocode-ai";
import { plainText } from "../styled-line.ts";

/**
 * Catalog estimates belong to the selected provider; account billing and service tiers may differ. Rates are the ones
 * in effect at `now`, so a time-limited price stops showing once it ends. `kind` names what the provider is.
 */
export function modelDetails(model: Model<any>, now: Date | number = Date.now(), kind?: string): string {
	const rate = (value: number) => (Number.isFinite(value) && value >= 0 ? `$${value}` : "unknown");
	const cost = activeRates(model.cost, now);
	const cache = model.promptCache
		? Object.entries(model.promptCache)
				.map(([tier, seconds]) => `${tier} ${seconds}s`)
				.join(", ")
		: "lifetime unspecified";
	return [
		`ID: ${plainText(model.provider)}/${plainText(model.id)}`,
		`Model Name: ${plainText(model.name)} · Provider: ${plainText(model.provider)}${kind ? ` (${plainText(kind)})` : ""}`,
		`Billing: ${kind === "subscription" ? "billed by plan; catalog API prices below are reference estimates" : kind === "local" ? "local server; hosting costs depend on your setup" : "metered; catalog prices are estimates"}`,
		`Image input: ${model.input.includes("image") ? "supported" : "not configured"}`,
		`Context ${model.contextWindow.toLocaleString("en-US")} · Max output ${model.maxTokens.toLocaleString("en-US")} · Thinking ${model.reasoning ? "supported (/effort)" : "unavailable"}`,
		`Catalog base USD/M tokens: input ${rate(cost.input)} · output ${rate(cost.output)} · cache read ${rate(cost.cacheRead)} · cache write ${rate(cost.cacheWrite)}`,
		`Cache: ${cache}${cost.tiers?.length ? ` · Pricing tiers above ${cost.tiers.map((tier) => tier.inputTokensAbove.toLocaleString("en-US")).join(" / ")} input tokens` : ""}. Account and service-tier billing may differ.`,
	]
		.map((line) => `  ${line}`)
		.join("\n");
}

/** The default picker view keeps capabilities and billing visible without pricing and cache paragraphs. */
export function compactModelDetails(model: Model<any>, kind: string): string[] {
	const tokens = (value: number) => (value >= 1000 ? `${Math.floor(value / 100) / 10}k` : String(value));
	return [
		` ${tokens(model.contextWindow)} context · ${tokens(model.maxTokens)} output`,
		` ${model.input.includes("image") ? "Images" : "Text only"} · ${model.reasoning ? "reasoning" : "no reasoning"} · ${kind === "subscription" ? "plan billing" : kind === "local" ? "local" : "metered"}`,
	];
}
