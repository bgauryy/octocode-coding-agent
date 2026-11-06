import { dirname, join } from "node:path";
import {
	InMemoryModelsStore,
	type ModelsRefreshOptions,
	type ModelsStore,
	type Provider,
} from "@octocodeai/octocode-ai";
import * as builtinProviderCatalog from "@octocodeai/octocode-ai/providers/all";
import { personalizeOpenRouterCatalog } from "@octocodeai/octocode-ai/providers/openrouter";
import { getAgentDir, getLegacyConfigDirs } from "../../config.ts";
import { isOfflineModeEnabled } from "../../utils/env-flag.ts";
import { AuthStorage as DefaultAuthStorage } from "../auth-storage.ts";
import { PiFallbackCredentialStore } from "../auth-storage/pi-fallback.ts";
import { ModelConfig } from "../model-config.ts";
import { FileModelsStore } from "../models-store.ts";
import { withPersonalizedCatalog, withRemoteCatalog } from "../remote-catalog-provider.ts";
import { RuntimeCredentials } from "../runtime-credentials.ts";
import type { CreateModelRuntimeOptions } from "./types.ts";

/** What `ModelRuntime.create()` loads before constructing the runtime. */
export interface ModelRuntimeParts {
	credentials: RuntimeCredentials;
	config: ModelConfig;
	modelsPath: string | undefined;
	modelsStore: ModelsStore;
	providers: Provider[];
	/** False in offline mode: catalog and availability refreshes stay local. */
	modelNetworkEnabled: boolean;
}

/** Load credentials, models.json and the catalog store, and create the built-in providers. */
export async function loadModelRuntimeParts(options: CreateModelRuntimeOptions): Promise<ModelRuntimeParts> {
	const credentials = new RuntimeCredentials(options.credentials ?? defaultCredentialStore(options.authPath));
	const modelsPath =
		options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
	const config = await ModelConfig.load(modelsPath);
	const modelsStore =
		options.modelsStore ??
		(modelsPath
			? new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))
			: new InMemoryModelsStore());
	const providers = createBuiltinProviders(options.catalogBaseUrl);
	return { credentials, config, modelsPath, modelsStore, providers, modelNetworkEnabled: !isOfflineModeEnabled() };
}

/**
 * Octocode's auth.json; for Octocode's own home with Pi compatibility on, Pi's auth.json files back it read-only (the
 * same rule that layers Pi's models.json under Octocode's in `ModelConfig.load`).
 */
function defaultCredentialStore(authPath = join(getAgentDir(), "auth.json")) {
	const storage = DefaultAuthStorage.create(authPath);
	const piDirs = getLegacyConfigDirs(dirname(authPath));
	return piDirs.length ? new PiFallbackCredentialStore(storage, piDirs) : storage;
}

/** The built-in providers, each refreshing its catalog from `catalogBaseUrl`. */
function createBuiltinProviders(catalogBaseUrl: string | undefined): Provider[] {
	const builtinModelDataGeneratedAt = builtinProviderCatalog.getBuiltinModelDataGeneratedAt();
	return builtinProviderCatalog.builtinProviders().map((provider) => {
		// OpenRouter narrows the catalog to the models, limits and prices of the user's key.
		if (provider.id === "openrouter") {
			return withPersonalizedCatalog(
				provider,
				personalizeOpenRouterCatalog,
				catalogBaseUrl,
				builtinModelDataGeneratedAt,
			);
		}
		return withRemoteCatalog(provider, catalogBaseUrl, builtinModelDataGeneratedAt);
	});
}

/** The create-time catalog and availability refresh, bounded by `modelRefreshTimeoutMs` when it uses the network. */
export async function refreshOnCreate(
	refresh: (options: ModelsRefreshOptions) => Promise<unknown>,
	modelNetworkEnabled: boolean,
	options: CreateModelRuntimeOptions,
): Promise<void> {
	const refreshFromNetwork = modelNetworkEnabled && options.allowModelNetwork === true;
	const controller =
		refreshFromNetwork && options.modelRefreshTimeoutMs !== undefined ? new AbortController() : undefined;
	const timeout = controller ? setTimeout(() => controller.abort(), options.modelRefreshTimeoutMs) : undefined;
	const signal = controller
		? options.signal
			? AbortSignal.any([options.signal, controller.signal])
			: controller.signal
		: options.signal;
	try {
		if (options.refreshOnCreate !== false) {
			await refresh({ allowNetwork: refreshFromNetwork, signal });
		}
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
