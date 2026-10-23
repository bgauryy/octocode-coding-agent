import type { Model } from "../../src/types.ts";
import { fetchNvidiaNimModelIds } from "./fetchers.ts";
import { addModelsDevFirstPartyModels } from "./models-dev-first-party.ts";
import { addModelsDevGatewayModels } from "./models-dev-gateways.ts";
import { addModelsDevHostedModels } from "./models-dev-hosted.ts";
import { addModelsDevPlanModels } from "./models-dev-plans.ts";
import { generatorOptions } from "./options.ts";
import type { ModelsDevCatalog } from "./types.ts";

/** The models.dev chat catalog, built provider by provider. */

export async function loadModelsDevData(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from models.dev API...");
		const response = await fetch("https://models.dev/api.json");
		if (!response.ok) throw new Error(`models.dev API returned ${response.status}`);
		const data = (await response.json()) as ModelsDevCatalog;

		const models: Model<any>[] = [];
		const nvidiaNimModelIds = data.nvidia?.models ? await fetchNvidiaNimModelIds() : new Map<string, string>();

		addModelsDevFirstPartyModels(data, models);
		addModelsDevHostedModels(data, models, nvidiaNimModelIds);
		addModelsDevGatewayModels(data, models);
		addModelsDevPlanModels(data, models);

		console.log(`Loaded ${models.length} tool-capable models from models.dev`);
		return models;
	} catch (error) {
		console.error("Failed to load models.dev data:", error);
		if (generatorOptions.strict) throw error;
		return [];
	}
}
