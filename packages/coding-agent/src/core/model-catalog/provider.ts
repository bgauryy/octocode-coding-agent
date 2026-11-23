import { isModelType, type Provider } from "@octocodeai/octocode-ai";
import { getBuiltinModelsDevSource } from "@octocodeai/octocode-ai/providers/all";
import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../settings-manager.ts";
import { countingPublications } from "../provider-composer/model-lists.ts";
import { modelsDevEnabled, readListings } from "./index-store.ts";
import type { CatalogListings } from "./index-shape.ts";
import {
	applyCatalogUpdates,
	type BundledModelsDevSource,
	type CatalogUpdate,
	catalogUpdates,
	type ProviderCatalogUpdates,
} from "./merge.ts";

/**
 * The `modelCatalogUpdates` setting for this process (global only, on by default): read from the global settings the
 * first time it is needed; a session that changes it calls `set`. `OCTOCODE_MODELS_DEV=0` turns updates off as well.
 */
class CatalogUpdatesGate {
	private value: boolean | undefined;

	set(value: unknown): void {
		this.value = value !== false;
	}

	/** The setting alone (read once from the global settings). */
	setting(): boolean {
		if (this.value === undefined) {
			const agentDir = getAgentDir();
			this.set(SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getSettings().modelCatalogUpdates);
		}
		return this.value === true;
	}

	enabled(env: NodeJS.ProcessEnv = process.env): boolean {
		return modelsDevEnabled(env) && this.setting();
	}
}

const catalogUpdatesGate = new CatalogUpdatesGate();

/** Whether the `modelCatalogUpdates` setting is on (`catalogStatus` names it when it is off). */
export const catalogUpdatesSetting = (): boolean => catalogUpdatesGate.setting();

/** Where a wrapped provider reads the listings, the bundled stamp and the switch; tests pass their own. */
export interface CatalogUpdateSources {
	listings?: () => CatalogListings | undefined;
	bundled?: () => BundledModelsDevSource | undefined;
	enabled?: () => boolean;
}

/** The updates in effect per wrapped provider, for `catalogUpdateOf`. */
const inEffect = new WeakMap<Provider, () => ProviderCatalogUpdates | undefined>();

/**
 * A built-in provider with the models.dev catalog updates applied (see `merge.ts`). Each refresh of the provider reads
 * the built-in listings (a small file beside the index, parsed once per process while it is unchanged; never the whole
 * index when that file covers them) and recomputes its updates; reads of its models apply them. With no index or with
 * updates off, the provider's own models are returned unchanged.
 */
export function withCatalogUpdates(provider: Provider, sources: CatalogUpdateSources = {}): Provider {
	const listings = sources.listings ?? (() => readListings());
	const bundled = sources.bundled ?? getBuiltinModelsDevSource;
	const enabled = sources.enabled ?? (() => catalogUpdatesGate.enabled());
	let updates: ProviderCatalogUpdates | undefined;
	const wrapped: Provider = {
		...provider,
		getModels: () => applyCatalogUpdates(provider.getModels(), updates),
		getAllModels: () => applyCatalogUpdates(provider.getAllModels?.() ?? provider.getModels(), updates),
		refreshModels: async (given) => {
			// Counted: a provider composed over this one (a models.json entry naming its models) reads it again.
			const context = countingPublications(given);
			await provider.refreshModels?.(context);
			if (context.signal.aborted) return;
			const chat = (provider.getAllModels?.() ?? provider.getModels()).filter((model) => isModelType(model, "chat"));
			const next = enabled() ? catalogUpdates(provider.id, chat, listings(), bundled()) : undefined;
			await context.publish({
				update: () => {
					updates = next;
				},
			});
		},
	};
	inEffect.set(wrapped, () => updates);
	return wrapped;
}

/** What the catalog updates say about `modelId` of a provider `withCatalogUpdates` wrapped; undefined otherwise. */
export function catalogUpdateOf(provider: Provider | undefined, modelId: string): CatalogUpdate | undefined {
	return provider ? inEffect.get(provider)?.()?.flags.get(modelId) : undefined;
}
