import { isDeepStrictEqual } from "node:util";
import { deriveAgentRoute } from "@octocodeai/octocode-contracts/config";
import { activeRates, type Model, type ProviderPlan } from "@octocodeai/octocode-ai";
import { billedText } from "../../../../core/agent-session/fallback-switch.ts";
import type { ModelRuntime } from "../../../../core/model-runtime.ts";
import { plainText } from "../styled-line.ts";

/** The route a provider of this kind is reached by, as /providers shows it; none while the kind is unknown. */
function routeLabel(kind: string | undefined): string | undefined {
	return kind ? deriveAgentRoute({ runner: kind === "CLI", subscription: kind === "subscription" }) : undefined;
}

/**
 * Whether the user set the model's price in models.json: a custom model's own entry (window and price), or a
 * `modelOverrides` price over a built-in model, which then differs from the price it shipped with.
 */
export function userSetPrice(
	runtime: Pick<ModelRuntime, "getModelOrigin" | "getBuiltinProvider">,
	model: Model<any>,
): boolean {
	const origin = runtime.getModelOrigin(model);
	if (origin === "models.json") return true;
	if (origin !== "models.json+built-in") return false;
	const shipped = runtime
		.getBuiltinProvider(model.provider)
		?.getModels()
		.find((entry) => entry.id === model.id);
	const plain = (cost: Model<any>["cost"]) => JSON.parse(JSON.stringify(cost)) as unknown;
	return shipped !== undefined && !isDeepStrictEqual(plain(shipped.cost), plain(model.cost));
}

/**
 * How a provider's requests are paid for, in the words every billing label uses (`billedText`: by plan, per token), and
 * what the prices shown mean: catalog estimates, or the rates the user set in models.json (`yourPrice`).
 */
function billingText(
	kind: string | undefined,
	billing: ProviderPlan["billing"] | undefined,
	yourPrice: boolean,
): string {
	if (kind === "local") return "local server; hosting costs depend on your setup";
	if (billing === "plan") return `${billedText(billing)}; the API prices below are estimates at list price`;
	if (billing === undefined) return "unknown; catalog prices are estimates";
	return yourPrice ? `${billedText(billing)} at your price` : `${billedText(billing)}; catalog prices are estimates`;
}

/**
 * Catalog estimates belong to the selected provider; account billing and service tiers may differ. Rates are the ones
 * in effect at `now`, so a time-limited price stops showing once it ends. `kind` names what the provider is;
 * `yourPrice` (`userSetPrice`) marks rates the user set in models.json instead of the catalog's. Billing and the price
 * come right after the names, so the panel's first page (`DETAIL_ROWS`) shows them.
 */
export function modelDetails(
	model: Model<any>,
	now: Date | number = Date.now(),
	kind?: string,
	billing?: ProviderPlan["billing"],
	yourPrice = false,
): string {
	const rate = (value: number) => (Number.isFinite(value) && value >= 0 ? `$${value}` : "unknown");
	const cost = activeRates(model.cost, now);
	const cache = model.promptCache
		? Object.entries(model.promptCache)
				.map(([tier, seconds]) => `${tier} ${seconds}s`)
				.join(", ")
		: "lifetime unspecified";
	return [
		`ID: ${plainText(model.provider)}/${plainText(model.id)}`,
		`Model Name: ${plainText(model.name)} · Provider: ${plainText(model.provider)}${kind ? ` (${plainText(kind)})` : ""} · Route: ${routeLabel(kind) ?? "unknown"}`,
		`Billing: ${billingText(kind, billing, yourPrice)}`,
		`${yourPrice ? "Base USD/M tokens (your price)" : "Catalog base USD/M tokens"}: input ${rate(cost.input)} · output ${rate(cost.output)} · cache read ${rate(cost.cacheRead)} · cache write ${rate(cost.cacheWrite)}`,
		`Context ${model.contextWindow.toLocaleString("en-US")} · Max output ${model.maxTokens.toLocaleString("en-US")} · Thinking ${model.reasoning ? "supported (/effort)" : "unavailable"}`,
		`Image input: ${model.input.includes("image") ? "supported" : "not configured"}`,
		`Cache: ${cache}${cost.tiers?.length ? ` · Pricing tiers above ${cost.tiers.map((tier) => tier.inputTokensAbove.toLocaleString("en-US")).join(" / ")} input tokens` : ""}. Account and service-tier billing may differ.`,
	]
		.map((line) => `  ${line}`)
		.join("\n");
}

/** The default picker view keeps capabilities and billing visible without pricing and cache paragraphs. */
export function compactModelDetails(model: Model<any>, kind: string, billing?: ProviderPlan["billing"]): string[] {
	const tokens = (value: number) => (value >= 1000 ? `${Math.floor(value / 100) / 10}k` : String(value));
	return [
		` ${tokens(model.contextWindow)} context · ${tokens(model.maxTokens)} output`,
		` ${model.input.includes("image") ? "Images" : "Text only"} · ${model.reasoning ? "reasoning" : "no reasoning"} · ${kind === "local" ? "local" : billing ? billedText(billing) : "billing unknown"} · route ${routeLabel(kind) ?? "unknown"}`,
	];
}
