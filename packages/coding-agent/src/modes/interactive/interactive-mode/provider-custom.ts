import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { listPiModelProviders } from "../../../core/auth-storage/pi.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";
import { piConfigDirs } from "./provider-pi.ts";

type PathHost = Pick<ProviderManagerHost, "session">;

/** The Octocode models.json, or undefined when the runtime has no configuration directory. */
function octocodeModelsPath(host: PathHost): string | undefined {
	const directory = host.session.modelRuntime.getConfigurationDirectory();
	return directory ? join(directory, "models.json") : undefined;
}

/** Pi's models.json locations, in precedence order. */
function piModelsPaths(host: PathHost): string[] {
	return piConfigDirs(host).map((dir) => join(dir, "models.json"));
}

/** One models.json file `/providers` lists, with the providers it defines. */
export interface CustomModelsFile {
	origin: "Octocode" | "Pi";
	path: string;
	exists: boolean;
	/** Provider ids defined in the file; empty when it is missing, unreadable or (Pi) its source is off. */
	defines: string[];
	unreadable?: boolean;
}

/** Octocode's models.json first, then Pi's. Only paths and provider ids are read; no secret is resolved. */
export async function customModelsFiles(host: PathHost, piEnabled: boolean): Promise<CustomModelsFile[]> {
	const files: CustomModelsFile[] = [];
	const own = octocodeModelsPath(host);
	const lists: { origin: CustomModelsFile["origin"]; path: string; load: boolean }[] = [
		...(own ? [{ origin: "Octocode" as const, path: own, load: true }] : []),
		...piModelsPaths(host).map((path) => ({ origin: "Pi" as const, path, load: piEnabled })),
	];
	for (const { origin, path, load } of lists) {
		const exists = existsSync(path);
		let defines: string[] = [];
		let unreadable = false;
		if (exists && load) {
			try {
				defines = [...(await listPiModelProviders([dirname(path)])).keys()];
			} catch {
				unreadable = true;
			}
		}
		files.push({ origin, path, exists, defines, ...(unreadable ? { unreadable } : {}) });
	}
	return files;
}

/** The models.json that defines a provider, for its action menu: Octocode's first, then Pi's. */
export async function providerDefinitionFile(
	host: PathHost,
	providerId: string,
): Promise<{ path: string; origin: "Octocode" | "Pi" } | undefined> {
	const own = octocodeModelsPath(host);
	const ownPath = own ? (await listPiModelProviders([dirname(own)])).get(providerId) : undefined;
	if (ownPath) return { path: ownPath, origin: "Octocode" };
	const dirs = piConfigDirs(host);
	const path = dirs.length ? (await listPiModelProviders(dirs)).get(providerId) : undefined;
	return path ? { path, origin: "Pi" } : undefined;
}
