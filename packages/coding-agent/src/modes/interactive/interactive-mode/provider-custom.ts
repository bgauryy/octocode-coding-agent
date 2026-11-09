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
