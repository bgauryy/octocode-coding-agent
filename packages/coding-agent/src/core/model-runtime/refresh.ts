import { type MutableModels, type ModelsRefreshOptions, type ModelsRefreshResult } from "@octocodeai/octocode-ai";
import { operationSignal } from "@octocodeai/octocode-ai/utils/abort";
import { ModelConfig } from "../model-config.ts";
import type { ModelsProject } from "../model-config/project.ts";
import type { ModelAvailability } from "./availability.ts";
import type { ProviderLayers } from "./provider-layers.ts";
import type { ProviderPins } from "./provider-pins.ts";
import {
	forgetRefresh,
	refreshInputs,
	rememberRefresh,
	reusableRefresh,
	type SettledRefresh,
} from "./refresh-reuse.ts";

/** The runtime parts a catalog refresh reloads and updates. */
export interface RuntimeRefreshHost {
	readonly models: MutableModels;
	readonly layers: ProviderLayers;
	readonly availability: ModelAvailability;
	readonly modelsPath: string | undefined;
	readonly project: ModelsProject | undefined;
	readonly modelNetworkEnabled: boolean;
	/** Keeps the providers this refresh removes serving requests that already hold one of their models. */
	readonly pins: ProviderPins;
}

/** `ModelsRefreshOptions`, plus whether a recent full refresh may answer this one. */
export interface RuntimeRefreshOptions extends ModelsRefreshOptions {
	/**
	 * For an interactive open (/model): a full refresh that settled cleanly within `REFRESH_REUSE_MS`, while the followed
	 * models.json files and the project's trust are as it read them, answers this one. Availability is checked again
	 * (credentials can change where nothing watches) and providers that gained auth since get their catalogs refreshed.
	 * Ignored with `providers` or `force`: those always refresh.
	 */
	reuse?: boolean;
}

/**
 * Reload models.json (or apply `config`), recompose providers, refresh catalogs, then refresh availability; with
 * `reuse`, a recent full refresh may stand in (see `RuntimeRefreshOptions`). Any other refresh forgets the recent one,
 * and a clean full one that read models.json itself and could use the network as the runtime may is remembered.
 */
export async function refreshModelRuntime(
	host: RuntimeRefreshHost,
	options: RuntimeRefreshOptions,
	config?: ModelConfig,
): Promise<ModelsRefreshResult> {
	const { reuse, ...refresh } = options;
	const started = Date.now();
	// A caller's own config was read before this started: the files' revisions now may not be the ones it holds.
	const inputs = config ? undefined : refreshInputs(host.modelsPath, host.project);
	const full = !refresh.providers;
	const last = reuse && full && !refresh.force && inputs ? reusableRefresh(host.models, inputs, started) : undefined;
	if (last) return refreshReused(host, last, refresh);
	forgetRefresh(host.models);
	const result = await runRefresh(host, refresh, config);
	// A local-only pass while the runtime may use the network left remote catalogs unread: it answers nothing later.
	const networked = !host.modelNetworkEnabled || refresh.allowNetwork !== false;
	if (full && inputs && networked && !result.aborted && result.errors.size === 0) {
		const configured = new Set(host.availability.snapshot.configuredProviders);
		rememberRefresh(host.models, { at: started, inputs, configured });
	}
	return result;
}

/** A reused refresh: availability checked again, then the catalogs of the providers that gained auth since `last`. */
async function refreshReused(
	host: RuntimeRefreshHost,
	last: SettledRefresh,
	options: ModelsRefreshOptions,
): Promise<ModelsRefreshResult> {
	try {
		await host.availability.queueAvailabilityRefresh(options.signal);
	} catch {
		// As in a full pass: availability errors are recorded by the latest pass.
	}
	const configured = new Set(host.availability.snapshot.configuredProviders);
	const gained = [...configured].filter((providerId) => !last.configured.has(providerId));
	if (gained.length === 0) {
		last.configured = configured;
		return { aborted: options.signal?.aborted ?? false, errors: new Map() };
	}
	const result = await runRefresh(host, { ...options, providers: gained });
	if (!result.aborted && result.errors.size === 0) last.configured = configured;
	return result;
}

async function runRefresh(
	host: RuntimeRefreshHost,
	options: ModelsRefreshOptions,
	config?: ModelConfig,
): Promise<ModelsRefreshResult> {
	const { models, layers, availability } = host;
	const before = models.getProviders();
	// A caller that already loaded and checked models.json passes it: reading again could meet a later mid-save state.
	layers.config = config ?? (await ModelConfig.load(host.modelsPath, host.project));
	if (options.providers) {
		for (const providerId of new Set(options.providers)) layers.recomposeProvider(providerId);
		availability.updateModelSnapshot();
	} else {
		layers.rebuildProviders();
		availability.updateModelSnapshot();
	}
	host.pins.settle(before, models.getProviders());
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
