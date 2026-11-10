import type { CredentialKind } from "../../core/model-runtime/catalog.ts";
import { credentialSourceLabel } from "../../core/provider-composer/types.ts";
import type { ExtensionContext } from "../../core/features/index.ts";
import type { Catalog } from "./catalog.ts";
import { canRunTask, type ModelRef } from "./model.ts";
import { modelCost, priceRank, priceText } from "./models-command.ts";
import { describeHealth, providerHealth } from "./provider-health.ts";

type Registry = Pick<ExtensionContext, "modelRegistry">["modelRegistry"];

/** Each listed provider's credential kind, resolved once; a registry that cannot say leaves the map empty. */
export async function credentialKinds(
	registry: Registry,
	available: readonly ModelRef[],
	signal?: AbortSignal,
): Promise<ReadonlyMap<string, CredentialKind>> {
	const kinds = new Map<string, CredentialKind>();
	if (!registry.getCredentialKind) return kinds;
	const getKind = registry.getCredentialKind.bind(registry);
	await Promise.all(
		providersOf(available).map(async (provider) => kinds.set(provider, await getKind(provider, signal))),
	);
	return kinds;
}

/** Where a provider's credential comes from, or undefined when the registry does not say; never a value. */
function credentialText(
	registry: Registry,
	provider: string,
	kinds: ReadonlyMap<string, CredentialKind> | undefined,
): string | undefined {
	const auth = registry.getProviderAuthStatus?.(provider);
	if (!auth || (!auth.label && !auth.source)) return undefined;
	if (auth.source === "runtime") return "--api-key, this session only (tasks cannot use it)";
	// A plain key needs no word: "subscription" and "account" are what the agent must not mistake for a metered key.
	const kind = kinds?.get(provider);
	return `${kind && kind !== "key" ? `${kind} · ` : ""}${credentialSourceLabel(auth)}`;
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
	kinds?: ReadonlyMap<string, CredentialKind>,
): string {
	const providers = providersOf(available);
	if (providers.length === 0) return "Providers: none configured; the user connects one with /providers.";
	return [
		"Providers (credential source; last result):",
		...providers.map((provider) => {
			const from = credentialText(registry, provider, kinds);
			return `  ${provider}${from ? ` · ${from}` : ""}${describeHealth(providerHealth.get(provider))}`;
		}),
	].join("\n");
}

/**
 * One row per provider: credential, last result, how many models can run a task, and the cheapest and the dearest of
 * those (the dearest stands for the most capable) with their prices. `matched` adds how many of each provider's
 * models a filter kept. The agent reads one provider's models with `provider:<id>`.
 */
export function providerSummary(
	registry: Registry,
	available: readonly ModelRef[],
	catalog: Catalog | undefined,
	matched?: readonly ModelRef[],
	kinds?: ReadonlyMap<string, CredentialKind>,
): string {
	const providers = providersOf(available);
	if (providers.length === 0) return "Providers: none configured; the user connects one with /providers.";
	const priced = (model: ModelRef) => `${model.provider}/${model.id} (${priceText(modelCost(model, catalog))})`;
	return [
		"Providers (credential source; last result; models that can run a task; cheapest and most capable of them, price per million tokens in/out):",
		...providers.map((provider) => {
			const own = available.filter((model) => model.provider === provider);
			const runnable = own.filter((model) => canRunTask(model, catalog));
			const ranked = runnable
				.filter((model) => priceRank(modelCost(model, catalog)) !== Infinity)
				.sort((a, b) => priceRank(modelCost(a, catalog)) - priceRank(modelCost(b, catalog)));
			const cheapest = ranked[0];
			const dearest = ranked.at(-1);
			const range = !cheapest
				? ""
				: cheapest === dearest
					? ` · priced ${priced(cheapest)}`
					: ` · cheapest ${priced(cheapest)}, most capable ${priced(dearest!)}`;
			const from = credentialText(registry, provider, kinds);
			const count = `${runnable.length} runnable${runnable.length < own.length ? ` of ${own.length}` : ""}`;
			const match = matched ? ` · ${matched.filter((model) => model.provider === provider).length} match` : "";
			return `  ${provider}${from ? ` · ${from}` : ""} · ${count}${match}${range}${describeHealth(providerHealth.get(provider))}`;
		}),
	].join("\n");
}
