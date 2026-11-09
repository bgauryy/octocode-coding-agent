import { existsSync } from "node:fs";
import { join } from "node:path";
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
	unreadable?: boolean;
}

/** Where models.json files live: Octocode's configuration directory (if any) and Pi's folders in precedence order. */
export interface ModelsFileLocations {
	ownDir?: string;
	piDirs: readonly string[];
}

/** Octocode's models.json first, then Pi's. Only paths, provider ids and key presence are read; no secret is resolved. */
export async function customModelsFiles(
	locations: ModelsFileLocations,
	piEnabled: boolean,
): Promise<CustomModelsFile[]> {
	const lists: { origin: CustomModelsFile["origin"]; path: string; load: boolean }[] = [
		...(locations.ownDir
			? [{ origin: "Octocode" as const, path: join(locations.ownDir, "models.json"), load: true }]
			: []),
		...locations.piDirs.map((dir) => ({ origin: "Pi" as const, path: join(dir, "models.json"), load: piEnabled })),
	];
	const files: CustomModelsFile[] = [];
	for (const { origin, path, load } of lists) {
		const exists = existsSync(path);
		let defines: string[] = [];
		let keyed: string[] = [];
		let unreadable = false;
		if (exists && load) {
			const config = await ModelConfig.loadFile(path);
			if (config.getError()) unreadable = true;
			else {
				defines = [...config.getProviderIds()];
				keyed = defines.filter((id) => !!config.getProvider(id)?.apiKey);
			}
		}
		files.push({ origin, path, exists, defines, keyed, ...(unreadable ? { unreadable } : {}) });
	}
	return files;
}
