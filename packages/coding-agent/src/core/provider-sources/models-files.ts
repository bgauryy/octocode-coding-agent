import { existsSync } from "node:fs";
import { join } from "node:path";
import { isConfigValueConfigured } from "../config-value.ts";
import { ModelConfig } from "../model-config.ts";

/** One models.json file with the providers it defines. */
export interface CustomModelsFile {
	origin: "Octocode" | "Pi";
	path: string;
	exists: boolean;
	/** Provider ids defined in the file; empty when it is missing, unreadable or (Pi) its source is off. */
	defines: string[];
	/** The subset of `defines` that sets an `apiKey`. Only whether it is set: never the value. */
	keyed: string[];
	/** The subset of `keyed` whose key names an environment variable that is not set. Commands are never run. */
	unset: string[];
	/** Display name, host, model ids and each model's limits per defined provider. */
	details: Record<string, CustomProviderDetails>;
	unreadable?: boolean;
}

/** What one models.json entry says about its provider. Never its key. */
export interface CustomProviderDetails {
	name?: string;
	baseUrl?: string;
	models: string[];
	/** Context window and maximum output per model id, with the defaults a model without them gets. */
	limits: Record<string, { contextWindow: number; maxTokens: number }>;
}

/** The limits a models.json model gets when it sets none (the schema's defaults). */
export const DEFAULT_MODEL_LIMITS = { contextWindow: 128000, maxTokens: 16384 } as const;

/** Where models.json files live: Octocode's configuration directory (if any) and Pi's folders in precedence order. */
export interface ModelsFileLocations {
	ownDir?: string;
	piDirs: readonly string[];
}

/** Octocode's models.json first, then Pi's. Only paths, provider ids and key presence are read; no secret is resolved. */
export async function customModelsFiles(
	locations: ModelsFileLocations,
	piEnabled: boolean,
	env: NodeJS.ProcessEnv = process.env,
): Promise<CustomModelsFile[]> {
	const lists: { origin: CustomModelsFile["origin"]; path: string; load: boolean }[] = [
		...(locations.ownDir
			? [{ origin: "Octocode" as const, path: join(locations.ownDir, "models.json"), load: true }]
			: []),
		...locations.piDirs.map((dir) => ({ origin: "Pi" as const, path: join(dir, "models.json"), load: piEnabled })),
	];
	// Independent reads, loaded concurrently; `Promise.all` keeps the precedence order of `lists`.
	return Promise.all(
		lists.map(async ({ origin, path, load }): Promise<CustomModelsFile> => {
			const exists = existsSync(path);
			let defines: string[] = [];
			let keyed: string[] = [];
			let unset: string[] = [];
			const details: CustomModelsFile["details"] = {};
			let unreadable = false;
			if (exists && load) {
				const config = await ModelConfig.loadFile(path, { fallback: origin === "Pi" });
				if (config.isUnreadable()) unreadable = true;
				else {
					defines = [...config.getProviderIds()];
					keyed = defines.filter((id) => !!config.getProvider(id)?.apiKey);
					unset = keyed.filter(
						(id) => !isConfigValueConfigured(config.getProvider(id)!.apiKey!, env as Record<string, string>),
					);
					for (const id of defines) {
						const provider = config.getProvider(id);
						const models = provider?.models ?? [];
						details[id] = {
							...(provider?.name ? { name: provider.name } : {}),
							...(provider?.baseUrl ? { baseUrl: provider.baseUrl } : {}),
							models: models.map((model) => model.id),
							limits: Object.fromEntries(
								models.map((model) => [
									model.id,
									{
										contextWindow: model.contextWindow ?? DEFAULT_MODEL_LIMITS.contextWindow,
										maxTokens: model.maxTokens ?? DEFAULT_MODEL_LIMITS.maxTokens,
									},
								]),
							),
						};
					}
				}
			}
			return { origin, path, exists, defines, keyed, unset, details, ...(unreadable ? { unreadable } : {}) };
		}),
	);
}
