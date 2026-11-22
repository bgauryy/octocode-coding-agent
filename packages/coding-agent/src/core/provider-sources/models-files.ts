import { existsSync } from "node:fs";
import { join } from "node:path";
import { isConfigValueConfigured } from "../config-value.ts";
import { ModelConfig } from "../model-config.ts";
import { projectModelsPaths } from "../model-config/project.ts";

/** One models.json file with the providers it defines. */
export interface CustomModelsFile {
	origin: "Octocode" | "Pi";
	/** `project` files sit in the session folder and are read only while it is trusted. */
	scope: "global" | "project";
	/** False for a project file of a folder that is not trusted: it exists but is not read. Global files are always true. */
	trusted: boolean;
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
	/** Project files only: provider ids this file defines that a global file defines too (the project's wins). */
	shadows?: string[];
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
	/** The session folder: its project files are listed first, in discovery's order. */
	project?: { cwd: string; trusted: boolean };
	piDirs: readonly string[];
}

/**
 * The files in precedence order, as `ModelConfig.load` merges them: Octocode's project file, Pi's project file, then
 * Octocode's global file and Pi's. Only paths, provider ids and key presence are read; no secret is resolved.
 */
export async function customModelsFiles(
	locations: ModelsFileLocations,
	piEnabled: boolean,
	env: NodeJS.ProcessEnv = process.env,
): Promise<CustomModelsFile[]> {
	const { project } = locations;
	const projectFiles = project ? projectModelsPaths(project.cwd, piEnabled) : [];
	type Entry = Pick<CustomModelsFile, "origin" | "scope" | "trusted" | "path"> & { load: boolean };
	const projectEntry = (path: string, origin: Entry["origin"]): Entry => ({
		origin,
		scope: "project",
		trusted: project?.trusted ?? false,
		path,
		load: project?.trusted === true && (origin === "Octocode" || piEnabled),
	});
	const lists: Entry[] = [
		...(projectFiles[0] ? [projectEntry(projectFiles[0], "Octocode")] : []),
		...(projectFiles[1] ? [projectEntry(projectFiles[1], "Pi")] : []),
		...(locations.ownDir
			? [
					{
						origin: "Octocode" as const,
						scope: "global" as const,
						trusted: true,
						path: join(locations.ownDir, "models.json"),
						load: true,
					},
				]
			: []),
		...locations.piDirs.map((dir) => ({
			origin: "Pi" as const,
			scope: "global" as const,
			trusted: true,
			path: join(dir, "models.json"),
			load: piEnabled,
		})),
	];
	// Independent reads, loaded concurrently; `Promise.all` keeps the precedence order of `lists`.
	const entries = await Promise.all(
		lists.map(async ({ origin, scope, trusted, path, load }): Promise<CustomModelsFile> => {
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
			return {
				origin,
				scope,
				trusted,
				path,
				exists,
				defines,
				keyed,
				unset,
				details,
				...(unreadable ? { unreadable } : {}),
			};
		}),
	);
	const global = new Set(entries.filter((entry) => entry.scope === "global").flatMap((entry) => entry.defines));
	return entries.map((entry) =>
		entry.scope === "project" ? { ...entry, shadows: entry.defines.filter((id) => global.has(id)) } : entry,
	);
}
