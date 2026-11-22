/**
 * Where providers are configured, for the configuration page: Octocode's and Pi's `auth.json` and `models.json`, and the
 * state of the sources. It reuses what `/providers` computes (`describeProviderSources`, `customModelsFiles`,
 * `listPiProviderCredentials`). Only file paths' existence, provider ids, credential types and whether a `models.json`
 * entry sets an `apiKey` are read; no key, reference or command text leaves this module.
 */

import type { ProviderOrigin, ProviderSourceState } from "@octocodeai/octocode-contracts/config";
import { listPiProviderCredentials } from "../../core/auth-storage/pi.ts";
import { describeProviderSources } from "../../core/provider-sources/registry.ts";
import { customModelsFiles, type CustomProviderDetails } from "../../core/provider-sources/models-files.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";

export interface ProviderOriginsView {
	sources: ProviderSourceState[];
	origins: Map<string, ProviderOrigin[]>;
	disabled: ReadonlySet<string>;
	/** Name and models per provider a models.json defines; the first file that defines it wins. */
	custom: Map<string, CustomProviderInfo>;
	/** Fixed text when a file listed above could not be read. */
	error?: string;
}

export interface ProviderOriginsOptions {
	agentDir: string;
	/** Pi's configuration folders in precedence order, as discovery lists them. */
	piDirs: readonly string[];
	home?: string;
	/** The Octocode provider ids that `auth.json` holds an entry for. */
	octocodeAuthIds: Iterable<string>;
	settings: SettingsManager;
	/** Resolves the environment variables a models.json key names; default: the process's. */
	env?: NodeJS.ProcessEnv;
}

/** What a models.json entry says about its provider: shown for providers no built-in list knows. */
export interface CustomProviderInfo extends CustomProviderDetails {
	/** Defined in Octocode's own models.json, the file the page can edit. */
	own?: boolean;
}

export async function readProviderOrigins(options: ProviderOriginsOptions): Promise<ProviderOriginsView> {
	const { settings } = options;
	const described = describeProviderSources(settings.getProviderSources(), {
		agentDir: options.agentDir,
		...(options.home ? { home: options.home } : {}),
	});
	const sources = described
		.filter((source) => source.id === "octocode" || source.id === "pi")
		.map((source): ProviderSourceState => ({
			id: source.id as "octocode" | "pi",
			label: source.label,
			enabled: source.state.enabled,
			toggleable: source.toggleable,
			present: source.state.present,
		}));
	const piOn = sources.find((source) => source.id === "pi")?.enabled ?? true;
	const origins = new Map<string, ProviderOrigin[]>();
	const add = (provider: string, origin: ProviderOrigin) => {
		const list = origins.get(provider) ?? [];
		if (!list.some((entry) => entry.product === origin.product && entry.file === origin.file)) list.push(origin);
		origins.set(provider, list);
	};
	for (const id of options.octocodeAuthIds) add(id, { product: "octocode", file: "auth-json" });
	let error: string | undefined;
	if (piOn) {
		try {
			for (const entry of await listPiProviderCredentials([...options.piDirs]))
				add(entry.providerId, { product: "pi", file: "auth-json" });
		} catch {
			error = "A Pi auth.json could not be read; its credentials are not shown.";
		}
	}
	const files = await customModelsFiles({ ownDir: options.agentDir, piDirs: options.piDirs }, piOn, options.env);
	const custom = new Map<string, CustomProviderInfo>();
	for (const file of files) {
		if (file.unreadable) error ??= "A models.json file could not be read; its providers are not shown.";
		const product = file.origin === "Pi" ? "pi" : "octocode";
		for (const id of file.defines) {
			add(id, {
				product,
				file: "models-json",
				hasKey: file.keyed.includes(id),
				...(file.unset.includes(id) ? { keyUnset: true } : {}),
			});
			if (!custom.has(id))
				custom.set(id, {
					...(file.details[id] ?? { models: [], limits: {} }),
					...(file.origin === "Octocode" ? { own: true } : {}),
				});
		}
	}
	return {
		sources,
		origins,
		disabled: new Set(settings.getDisabledProviders()),
		custom,
		...(error ? { error } : {}),
	};
}
