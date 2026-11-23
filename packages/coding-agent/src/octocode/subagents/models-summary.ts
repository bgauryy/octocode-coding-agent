import { modelAvailableToChild } from "./task-model-visibility.ts";
import { deriveAgentRoute } from "@octocodeai/octocode-contracts/config";
import type { ProviderKind } from "../../core/model-runtime/catalog.ts";
import { credentialSourceLabel } from "../../core/provider-composer/types.ts";
import type { FeatureContext } from "../../core/features/index.ts";
import type { Catalog } from "../../core/model-catalog/index-shape.ts";
import { type ModelRef } from "./model.ts";
import { modelLine, modelCost, priceRank, priceText } from "./models-command.ts";
import { describeHealth, providerHealth } from "./provider-health.ts";

/** All connected models, including ones unsuitable for tasks; credential marks reflect the last check or run. */
export function compactModels(available: readonly ModelRef[], catalog: Catalog | undefined): string {
	return [
		"Models ($/M in/out · context; ✓ credential worked, ✗ failed, ? untried):",
		...[...available]
			.sort(
				(a, b) =>
					a.provider.localeCompare(b.provider) || priceRank(modelCost(a, catalog)) - priceRank(modelCost(b, catalog)),
			)
			.map((model) => {
				const status = providerHealth.get(model.provider);
				const mark = status ? (status.ok ? "✓" : "✗") : "?";
				return `${modelLine(model, undefined, catalog).trim().replace(" per M in/out", "")} · ${mark}`;
			}),
		...(available.length ? [] : ["No models are configured."]),
	].join("\n");
}

type Registry = Pick<FeatureContext, "modelRegistry">["modelRegistry"];

/** Each listed provider's kind (`ModelRegistry.getProviderKind`); a registry that cannot say leaves the map empty. */
export function providerKinds(registry: Registry, available: readonly ModelRef[]): ReadonlyMap<string, ProviderKind> {
	if (!registry.getProviderKind) return new Map();
	return new Map(providersOf(available).map((provider) => [provider, registry.getProviderKind(provider)] as const));
}

/** The provider's kind and where its credential comes from, or undefined when the registry says neither; never a value. */
function credentialText(
	registry: Registry,
	provider: string,
	kinds: ReadonlyMap<string, ProviderKind> | undefined,
): string | undefined {
	const auth = registry.getProviderAuthStatus?.(provider);
	if (auth?.source === "runtime") {
		if (!auth.hasInheritedAuth) return "--api-key, this session only (tasks cannot use it)";
		const billing = registry.getProviderBilling?.(provider, "child");
		return `--api-key for this session; tasks use their own configured credentials${billing ? ` (task billing: ${billing})` : ""}`;
	}
	const source = auth && (auth.label || auth.source) ? credentialSourceLabel(auth) : undefined;
	const kind = kinds?.get(provider);
	const route = kind
		? `route ${deriveAgentRoute({ runner: kind === "CLI", subscription: kind === "subscription" })}`
		: undefined;
	return [kind, source, route].filter(Boolean).join(" · ") || undefined;
}

const providersOf = (available: readonly ModelRef[]): string[] =>
	[...new Set(available.map((model) => model.provider))].sort();

/**
 * Each configured provider (one with a usable model): where its credential comes from and what this process last
 * learned about it. A provider authenticated only by this session's --api-key is listed, but a task cannot run on it.
 */
export function providerRows(
	registry: Registry,
	available: readonly ModelRef[],
	kinds?: ReadonlyMap<string, ProviderKind>,
): string {
	const providers = providersOf(available);
	if (providers.length === 0) return "Providers: none configured; the user connects one with /providers.";
	return [
		"Providers (kind · credential source · route; last result):",
		...providers.map((provider) => {
			const from = credentialText(registry, provider, kinds);
			return `  ${provider}${from ? ` · ${from}` : ""}${describeHealth(providerHealth.get(provider))}`;
		}),
	].join("\n");
}

/**
 * One row per provider: credential, last result, how many models can run a task, and the cheapest and the dearest of
 * those by blended price, with their rates. `matched` adds how many of each provider's
 * models a filter kept. The agent reads one provider's models with `provider:<id>`.
 */
export function providerSummary(
	registry: Registry,
	available: readonly ModelRef[],
	catalog: Catalog | undefined,
	matched?: readonly ModelRef[],
	kinds?: ReadonlyMap<string, ProviderKind>,
): string {
	const providers = providersOf(available);
	if (providers.length === 0) return "Providers: none configured; the user connects one with /providers.";
	const priced = (model: ModelRef) => `${model.provider}/${model.id} (${priceText(modelCost(model, catalog))})`;
	return [
		"Providers (kind · credential source · route; last result; model count; cheapest and highest priced, price per million tokens in/out):",
		...providers.map((provider) => {
			const own = available.filter((model) => model.provider === provider);
			const runnable = own.filter((model) => modelAvailableToChild(registry, model));
			const ranked = runnable
				.filter((model) => priceRank(modelCost(model, catalog)) !== Infinity)
				.sort((a, b) => priceRank(modelCost(a, catalog)) - priceRank(modelCost(b, catalog)));
			const cheapest = ranked[0];
			const dearest = ranked.at(-1);
			const range = !cheapest
				? ""
				: cheapest === dearest
					? ` · priced ${priced(cheapest)}`
					: ` · cheapest ${priced(cheapest)}, highest priced ${priced(dearest!)}`;
			const from = credentialText(registry, provider, kinds);
			const count = `${runnable.length} runnable${runnable.length < own.length ? ` of ${own.length}` : ""}`;
			const match = matched ? ` · ${matched.filter((model) => model.provider === provider).length} match` : "";
			return `  ${provider}${from ? ` · ${from}` : ""} · ${count}${match}${range}${describeHealth(providerHealth.get(provider))}`;
		}),
	].join("\n");
}
