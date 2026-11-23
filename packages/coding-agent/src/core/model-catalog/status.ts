import { getBuiltinModelsDevSource } from "@octocodeai/octocode-ai/providers/all";
import { isOfflineModeEnabled } from "../../utils/env-flag.ts";
import { isCurrentCatalog } from "./index-shape.ts";
import {
	CATALOG_TTL_MS,
	catalogFile,
	indexFacts,
	MODELS_DEV_ENV,
	modelsDevEnabled,
	readCatalog,
} from "./index-store.ts";
import { catalogUpdatesSetting } from "./provider.ts";

/** Where the index stands, for `/status` and the `models` tool. */
export interface CatalogStatus {
	/** When the index in use was fetched; undefined when there is none. */
	fetchedAt: number | undefined;
	/** `live`: this process fetched it; `cache`: read from an earlier fetch; `off`: `OCTOCODE_MODELS_DEV=0`. */
	source: "live" | "cache" | "off";
	/** Older than a day (a refresh is due, failed, or is off while offline). */
	stale: boolean;
	/** Why the saved index was ignored or not refreshed, or why the last fetch or save failed. */
	problem?: string;
	/**
	 * Why catalog updates (deprecation marks, newer prices, added models) do nothing, or do less, right now; absent when
	 * they apply in full.
	 */
	inert?: string;
}

/** Why catalog updates are inert or limited, in the order a user would fix it; undefined when they apply in full. */
function inertReason(env: NodeJS.ProcessEnv, hasIndex: boolean, current: boolean): string | undefined {
	if (!modelsDevEnabled(env)) return `models.dev is off (${MODELS_DEV_ENV}=0)`;
	if (!catalogUpdatesSetting()) return "the modelCatalogUpdates setting is off";
	if (!hasIndex)
		return isOfflineModeEnabled(env)
			? "no models.dev index yet, and offline mode fetches none"
			: "no models.dev index yet (fetched in the background)";
	if (!current) return "the saved index predates per-provider listings: only bare ids are read until it is refetched";
	if (!getBuiltinModelsDevSource())
		return "the bundled catalog does not record its models.dev sources: deprecations are marked, but no prices change and no models are added";
	return undefined;
}

/** The index's state from what is already loaded or saved; reads the whole index only when this process has not yet. */
export function catalogStatus(env: NodeJS.ProcessEnv = process.env, now = Date.now()): CatalogStatus {
	if (!modelsDevEnabled(env))
		return { fetchedAt: undefined, source: "off", stale: false, inert: `models.dev is off (${MODELS_DEV_ENV}=0)` };
	const file = catalogFile(env);
	const catalog = readCatalog(file);
	const { problem, live } = indexFacts(file);
	const stale = catalog === undefined || now - catalog.fetchedAt >= CATALOG_TTL_MS;
	const offline = stale && isOfflineModeEnabled(env) ? "offline: the index is not refreshed" : undefined;
	const inert = inertReason(env, catalog !== undefined, catalog !== undefined && isCurrentCatalog(catalog));
	return {
		fetchedAt: catalog?.fetchedAt,
		source: live ? "live" : "cache",
		stale,
		...((problem ?? offline) ? { problem: problem ?? offline } : {}),
		...(inert ? { inert } : {}),
	};
}
