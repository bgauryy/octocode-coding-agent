import type { ModelMetadataMap, ProviderMap } from "@opencode-ai/models";
import type { ModelsDevCatalog } from "../../src/catalog/models-dev-fields.ts";
import { catalogRequestOptions, modelsDev } from "./fetchers.ts";
import { generatorOptions } from "./options.ts";

/**
 * The models.dev data one generator run reads: the snapshot the pinned `@opencode-ai/models` ships by default, so a
 * regenerated catalog depends on the package version alone and needs no network; models.dev itself with `--live`.
 */
export interface ModelsDevSource {
	/** Standard (chat) models by provider, the shape of `api.json` without `?type=`. */
	providers: ModelsDevCatalog;
	/** Provider-agnostic metadata of the decision models the classifier catalog reads. */
	decisionModels(): Promise<ModelMetadataMap>;
	/** When the data was taken: the snapshot's stamp, or the time of the live fetch. */
	generatedAt: string;
}

/** Standard models only, as `api.json` serves them without `?type=`: the snapshot holds every model type. */
function standardModels(providers: ProviderMap): ModelsDevCatalog {
	return Object.fromEntries(
		Object.entries(providers).map(([id, provider]) => [
			id,
			{
				...provider,
				models: Object.fromEntries(Object.entries(provider.models ?? {}).filter(([, model]) => !model.type)),
			},
		]),
	);
}

/** Decision models only, as `models.json?type=decision` serves them. */
function decisionModels(models: ModelMetadataMap): ModelMetadataMap {
	return Object.fromEntries(Object.entries(models).filter(([, model]) => model.type === "decision"));
}

export async function loadModelsDevSource(): Promise<ModelsDevSource> {
	if (generatorOptions.live) {
		console.log("Fetching models from models.dev API...");
		const fetchedAt = new Date().toISOString();
		return {
			providers: await modelsDev.providers(catalogRequestOptions()),
			decisionModels: () => modelsDev.models({ ...catalogRequestOptions(), modelTypes: ["decision"] }),
			generatedAt: fetchedAt,
		};
	}
	// Loaded only when used: the snapshot module is several megabytes.
	const snapshot = await import("@opencode-ai/models/snapshot");
	console.log(`Reading the models.dev snapshot of @opencode-ai/models (generated ${snapshot.generatedAt})...`);
	return {
		providers: standardModels(snapshot.providers),
		decisionModels: async () => decisionModels(snapshot.models),
		generatedAt: snapshot.generatedAt,
	};
}
