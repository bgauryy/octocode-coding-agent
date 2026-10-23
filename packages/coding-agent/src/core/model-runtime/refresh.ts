import { type MutableModels, type ModelsRefreshOptions, type ModelsRefreshResult } from "@octocodeai/octocode-ai";
import { operationSignal } from "@octocodeai/octocode-ai/utils/abort";
import { ModelConfig } from "../model-config.ts";
import type { ModelAvailability } from "./availability.ts";
import type { ProviderLayers } from "./provider-layers.ts";

/** The runtime parts a catalog refresh reloads and updates. */
export interface RuntimeRefreshHost {
	readonly models: MutableModels;
	readonly layers: ProviderLayers;
	readonly availability: ModelAvailability;
	readonly modelsPath: string | undefined;
	readonly modelNetworkEnabled: boolean;
}

/** Reload models.json, recompose providers, refresh catalogs, then refresh availability. */
export async function refreshModelRuntime(
	host: RuntimeRefreshHost,
	options: ModelsRefreshOptions,
): Promise<ModelsRefreshResult> {
	const { models, layers, availability } = host;
	layers.config = await ModelConfig.load(host.modelsPath);
	if (options.providers) {
		for (const providerId of new Set(options.providers)) layers.recomposeProvider(providerId);
		availability.updateModelSnapshot();
	} else {
		layers.rebuildProviders();
		availability.updateModelSnapshot();
	}
	const refreshOptions = {
		...options,
		allowNetwork: options.allowNetwork ?? host.modelNetworkEnabled,
	};
	// Published octocode-ai builds before ModelsStore returned void and accepted a provider ID.
	// The fallback keeps source-mode CLI tests working without rebuilding workspace dependencies.
	const result = ((await models.refresh(refreshOptions)) as ModelsRefreshResult | undefined) ?? {
		aborted: refreshOptions.signal?.aborted ?? false,
		errors: new Map(),
	};
	const errors = new Map(result.errors);
	availability.updateModelSnapshot();
	if (options.providers) {
		await Promise.all(
			[...new Set(options.providers)].map(async (providerId) => {
				try {
					await availability.refreshProviderAvailability(providerId, operationSignal(options.signal));
				} catch (error) {
					if (!options.signal?.aborted) {
						errors.set(providerId, error instanceof Error ? error : new Error(String(error)));
					}
				}
			}),
		);
	} else {
		try {
			await availability.queueAvailabilityRefresh(options.signal);
		} catch {
			// Availability errors are recorded by the latest pass; refreshed models remain usable.
		}
	}
	return { aborted: result.aborted || (options.signal?.aborted ?? false), errors };
}
