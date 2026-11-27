import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyModel, Api, ClassifierApi, ClassifierModel, ImageApi, ImageModel, Model } from "../../src/types.ts";
import { readModelDataProviderIds, validateGeneratedModelData } from "../model-data.ts";
import type { OpenRouterCatalog } from "../openrouter-catalog.ts";
import {
	CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS,
	OPENAI_CLASSIFIER_MODELS,
	OPENCODE_CLASSIFIER_MODELS,
} from "./classifiers.ts";
import { applyImageInputMetadata } from "./metadata.ts";
import { generatorOptions, packageRoot } from "./options.ts";

/** Generated models grouped and sorted by provider. */

// Keep chat and image catalogs separate so one upstream ID can expose both
// operations with different API implementations.
type ProviderCatalog = {
	chat: Record<string, Model<Api>>;
	image: Record<string, ImageModel<ImageApi>>;
	classifier: Record<string, ClassifierModel<ClassifierApi>>;
};

/** Groups chat, image and classifier models by provider; a targeted refresh keeps the saved catalog outside its scope. */
export function buildProviderCatalogs(
	allModels: Model<any>[],
	openRouterCatalog: OpenRouterCatalog,
	aiGatewayCatalog: { classifiers: ClassifierModel<ClassifierApi>[] },
	modelsDevClassifierModels: ClassifierModel<ClassifierApi>[],
): Record<string, ProviderCatalog> {
	const providers: Record<string, ProviderCatalog> = {};
	for (const model of allModels) {
		providers[model.provider] ??= { chat: {}, image: {}, classifier: {} };
		// Only add if not already present (models.dev takes priority over OpenRouter).
		providers[model.provider].chat[model.id] ??= { ...model, type: "chat" };
	}
	for (const model of openRouterCatalog.images) {
		applyImageInputMetadata(model);
		providers[model.provider] ??= { chat: {}, image: {}, classifier: {} };
		providers[model.provider].image[model.id] ??= model;
	}
	const classifierModels: ClassifierModel<ClassifierApi>[] = [
		...modelsDevClassifierModels,
		...openRouterCatalog.classifiers,
		...aiGatewayCatalog.classifiers,
		...OPENCODE_CLASSIFIER_MODELS,
		...CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS,
		...OPENAI_CLASSIFIER_MODELS,
	];
	for (const model of classifierModels) {
		providers[model.provider] ??= { chat: {}, image: {}, classifier: {} };
		providers[model.provider].classifier[model.id] ??= model;
	}

	// Targeted refreshes retain the current catalog outside their scope and keep
	// existing IDs within it. Full generation still follows the upstream catalog.
	if (generatorOptions.providers) {
		validateGeneratedModelData(packageRoot);
		for (const id of generatorOptions.providers) {
			if (!providers[id]) throw new Error(`Unknown generated provider: ${id}`);
		}
		const selected = new Set(generatorOptions.providers);
		for (const id of readModelDataProviderIds(packageRoot)) {
			const groups = JSON.parse(readFileSync(join(packageRoot, "src/providers/data", `${id}.json`), "utf8")) as Record<
				string,
				Record<string, AnyModel>
			>;
			const saved: ProviderCatalog = { chat: {}, image: {}, classifier: {} };
			for (const model of Object.values(groups).flatMap(Object.values)) {
				if (model.type === "image") saved.image[model.id] = model;
				else if (model.type === "classifier") saved.classifier[model.id] = model;
				else saved.chat[model.id] = model;
			}
			providers[id] = selected.has(id)
				? {
						chat: { ...saved.chat, ...providers[id]?.chat },
						image: { ...saved.image, ...providers[id]?.image },
						classifier: { ...saved.classifier, ...providers[id]?.classifier },
					}
				: saved;
		}
		for (const id of Object.keys(providers)) {
			if (!selected.has(id) && !existsSync(join(packageRoot, "src/providers/data", `${id}.json`))) delete providers[id];
		}
	}
	return providers;
}

export interface SortedProviderCatalogs {
	sortedProviderIds: string[];
	jsonChatProviders: Record<string, Record<string, Model<Api>>>;
	jsonImageProviders: Record<string, Record<string, ImageModel<ImageApi>>>;
	jsonClassifierProviders: Record<string, Record<string, ClassifierModel<ClassifierApi>>>;
	jsonAllProviders: Record<string, AnyModel[]>;
}

export function sortProviderCatalogs(providers: Record<string, ProviderCatalog>): SortedProviderCatalogs {
	// Code-unit order, like the provider ids: localeCompare would follow the generating machine's locale.
	const byKey = ([left]: [string, unknown], [right]: [string, unknown]) => (left < right ? -1 : left > right ? 1 : 0);
	const sortedProviderIds = Object.keys(providers).sort();
	const jsonChatProviders: Record<string, Record<string, Model<Api>>> = {};
	const jsonImageProviders: Record<string, Record<string, ImageModel<ImageApi>>> = {};
	const jsonClassifierProviders: Record<string, Record<string, ClassifierModel<ClassifierApi>>> = {};
	const jsonAllProviders: Record<string, AnyModel[]> = {};
	for (const providerId of sortedProviderIds) {
		jsonChatProviders[providerId] = Object.fromEntries(Object.entries(providers[providerId].chat).sort(byKey));
		jsonImageProviders[providerId] = Object.fromEntries(Object.entries(providers[providerId].image).sort(byKey));
		jsonClassifierProviders[providerId] = Object.fromEntries(
			Object.entries(providers[providerId].classifier).sort(byKey),
		);
		jsonAllProviders[providerId] = [
			...Object.values(jsonChatProviders[providerId]),
			...Object.values(jsonImageProviders[providerId]),
			...Object.values(jsonClassifierProviders[providerId]),
		];
	}
	return { sortedProviderIds, jsonChatProviders, jsonImageProviders, jsonClassifierProviders, jsonAllProviders };
}
