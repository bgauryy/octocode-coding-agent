import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	InMemoryModelsStore,
	type ModelsRefreshOptions,
	type ModelsStore,
	type Provider,
} from "@octocodeai/octocode-ai";
import * as builtinProviderCatalog from "@octocodeai/octocode-ai/providers/all";
import { personalizeOpenRouterCatalog } from "@octocodeai/octocode-ai/providers/openrouter";
import { setUserAgentVersion } from "@octocodeai/octocode-ai/utils/user-agent";
import { getAgentDir, providerFallbackDirs, VERSION } from "../../config.ts";
import { isOfflineModeEnabled } from "../../utils/env-flag.ts";
import { AuthStorage as DefaultAuthStorage, ReadOnlyAuthStorage } from "../auth-storage.ts";
import { PiFallbackCredentialStore } from "../auth-storage/pi-fallback.ts";
import { ModelConfig } from "../model-config.ts";
import type { ModelsProject } from "../model-config/project.ts";
import { withCopilotEnvSource } from "../provider-sources/copilot-env.ts";
import { FileModelsStore } from "../models-store.ts";
import { withPersonalizedCatalog, withRemoteCatalog } from "../remote-catalog-provider.ts";
import { RuntimeCredentials } from "../runtime-credentials.ts";
import { installSecretRedaction } from "../secret-redaction.ts";
import type { CreateModelRuntimeOptions } from "./types.ts";

/** What `ModelRuntime.create()` loads before constructing the runtime. */
export interface ModelRuntimeParts {
	credentials: RuntimeCredentials;
	config: ModelConfig;
	modelsPath: string | undefined;
	project: ModelsProject | undefined;
	modelsStore: ModelsStore;
	providers: Provider[];
	/** False in offline mode: catalog and availability refreshes stay local. */
	modelNetworkEnabled: boolean;
	/** Whether a login or credential change starts a network refresh of its provider: network on and requested. */
	refreshAfterCredentialChange: boolean;
}

/** Load credentials, models.json and the catalog store, and create the built-in providers. */
export async function loadModelRuntimeParts(options: CreateModelRuntimeOptions): Promise<ModelRuntimeParts> {
	// Every session of every mode builds its runtime here, before the first provider call can fail with a credential in its text.
	installSecretRedaction();
	// Every provider request names this version in its User-Agent.
	setUserAgentVersion(VERSION);
	const modelsPath =
		options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
	const providers = createBuiltinProviders(options.catalogBaseUrl);
	const credentials = new RuntimeCredentials(
		options.credentials ?? createDefaultCredentialStore({ ...options, modelsPath: modelsPath ?? null }, providers),
	);
	const config = await ModelConfig.load(modelsPath, options.project);
	const modelsStore =
		options.modelsStore ??
		(modelsPath
			? new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))
			: new InMemoryModelsStore());
	const modelNetworkEnabled = !isOfflineModeEnabled();
	return {
		credentials,
		config,
		modelsPath,
		project: options.project,
		modelsStore,
		providers,
		modelNetworkEnabled,
		refreshAfterCredentialChange: modelNetworkEnabled && options.allowModelNetwork === true,
	};
}

/**
 * Octocode's auth.json; for Octocode's own home with Pi compatibility on, the legacy `~/.octocode` folders' and Pi's
 * auth.json files back it read-only (the same rule that layers their models.json under Octocode's in `ModelConfig.load`).
 * A provider keyed in Octocode's own models.json, or a built-in provider without an OAuth sign-in, skips their entries.
 */
export function createDefaultCredentialStore(
	options: Pick<CreateModelRuntimeOptions, "authPath" | "modelsPath" | "readOnlyCredentials" | "keychain"> = {},
	providers: readonly Provider[] = createBuiltinProviders(undefined),
) {
	const authPath = options.authPath ?? join(getAgentDir(), "auth.json");
	const modelsPath =
		options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
	const storage = options.readOnlyCredentials
		? new ReadOnlyAuthStorage(authPath)
		: DefaultAuthStorage.create(authPath, options.keychain ? { keychain: options.keychain } : undefined);
	const fallbackDirs = providerFallbackDirs(dirname(authPath));
	if (!fallbackDirs.length) return storage;
	const builtin = new Map(providers.map((provider) => [provider.id, provider]));
	return new PiFallbackCredentialStore(storage, fallbackDirs, {
		ownsKey: modelsPath ? ownKeyedProviders(modelsPath) : undefined,
		supportsOAuth: (providerId) => {
			const provider = builtin.get(providerId);
			return provider ? provider.auth.oauth !== undefined : true;
		},
	});
}

/** Whether Octocode's own models.json (that file alone) sets `apiKey` for a provider; re-read when the file changes. */
function ownKeyedProviders(modelsPath: string): (providerId: string) => Promise<boolean> {
	let cached: { stamp: string; keyed: Promise<ReadonlySet<string>> } | undefined;
	return async (providerId) => {
		let stamp: string;
		try {
			const stat = statSync(modelsPath);
			stamp = `${stat.mtimeMs}:${stat.size}`;
		} catch {
			return false;
		}
		if (cached?.stamp !== stamp) {
			const keyed = ModelConfig.loadFile(modelsPath).then(
				(config) => new Set(config.getProviderIds().filter((id) => config.getProvider(id)?.apiKey !== undefined)),
			);
			cached = { stamp, keyed };
		}
		return (await cached.keyed).has(providerId);
	};
}

/** The built-in providers, each refreshing its catalog from `catalogBaseUrl`. */
function createBuiltinProviders(catalogBaseUrl: string | undefined): Provider[] {
	const builtinModelDataGeneratedAt = builtinProviderCatalog.getBuiltinModelDataGeneratedAt();
	return builtinProviderCatalog.builtinProviders().map((builtin) => {
		const provider = withCopilotEnvSource(builtin);
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
