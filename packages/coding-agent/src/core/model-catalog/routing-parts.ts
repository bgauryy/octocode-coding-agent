import path from "node:path";
import { getBuiltinModels, getBuiltinProviders } from "@octocodeai/octocode-ai/providers/all";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { type Catalog, CATALOG_VERSION, type CatalogModel, listedModel } from "./index-shape.ts";

/**
 * What routing reads of the index besides the built-in listings (`routingCatalog`): the models.dev providers, every bare
 * id, and the bare entries a built-in model's lookup reaches because its own listing lacks the id. Saved beside the
 * index with the listings, so routing need not parse the whole index; process start never reads it.
 */
export interface RoutingParts {
	version: number;
	fetchedAt: number;
	providers: string[];
	bareIds: string[];
	bare: Record<string, CatalogModel>;
}

/** Where the routing parts are kept, beside the index `file`. */
export const routingFileOf = (file: string): string =>
	path.join(path.dirname(file), `${path.basename(file, ".json")}-routing.json`);

export function routingParts(catalog: Catalog): RoutingParts {
	const bare: Record<string, CatalogModel> = {};
	for (const provider of getBuiltinProviders())
		for (const { id } of getBuiltinModels(provider)) {
			if (listedModel(catalog, provider, id)) continue;
			for (const key of [id, id.slice(id.lastIndexOf("/") + 1)])
				if (catalog.models[key]) bare[key] = catalog.models[key];
		}
	return {
		version: CATALOG_VERSION,
		fetchedAt: catalog.fetchedAt,
		providers: catalog.providers,
		bareIds: Object.keys(catalog.models),
		bare,
	};
}

export const asRoutingParts = (value: unknown): RoutingParts | undefined =>
	isRecord(value) &&
	value.version === CATALOG_VERSION &&
	typeof value.fetchedAt === "number" &&
	Array.isArray(value.providers) &&
	Array.isArray(value.bareIds) &&
	isRecord(value.bare)
		? (value as unknown as RoutingParts)
		: undefined;
