import type { ModelsDevCatalog } from "./types.ts";
import type { Model } from "../../src/types.ts";
import { fetchNvidiaNimModelIds } from "./fetchers.ts";
import { addModelsDevFirstPartyModels } from "./models-dev-first-party.ts";
import { addModelsDevGatewayModels } from "./models-dev-gateways.ts";
import { addModelsDevHostedModels } from "./models-dev-hosted.ts";
import { addModelsDevPlanModels } from "./models-dev-plans.ts";
import { refreshesProvider } from "./options.ts";

/** The models.dev chat catalog, built provider by provider. */

export async function loadModelsDevData(data: ModelsDevCatalog): Promise<Model<any>[]> {
	const models: Model<any>[] = [];
	const nvidiaNimModelIds =
		refreshesProvider("nvidia") && data.nvidia?.models ? await fetchNvidiaNimModelIds() : new Map<string, string>();

	addModelsDevFirstPartyModels(data, models);
	addModelsDevHostedModels(data, models, nvidiaNimModelIds);
	addModelsDevGatewayModels(data, models);
	addModelsDevPlanModels(data, models);

	const listed = Object.values(data).reduce((total, provider) => total + Object.keys(provider.models ?? {}).length, 0);
	console.log(
		`Selected ${models.length} tool-capable entries from ${listed} models.dev listings across ${Object.keys(data).length} upstream providers`,
	);
	return models;
}
