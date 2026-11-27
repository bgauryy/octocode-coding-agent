import type { Model as ModelsDevModel } from "@opencode-ai/models";
import {
	getModelsDevCost,
	isModelsDevChat,
	modelsDevTextOutput,
} from "@octocodeai/octocode-ai/catalog/models-dev-fields";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * The models.dev index (https://models.dev, MIT): an open catalog of model capabilities, limits, prices and lifecycle.
 * Kept small on disk, so a field is present only when the listing gives it (routing tells "unknown" from "no" and from
 * zero), and fields nothing reads (descriptions, reasoning option lists) are not kept. Prices come through the shared
 * field mapper (`ModelsDevFields`), tiers included.
 */

/** What Octocode reads from one models.dev model entry (prices per million tokens). */
export interface CatalogModel {
	name?: string;
	knowledge?: string;
	/** Model family (`claude-haiku`, `gpt-mini`): its newest release is the current one. */
	family?: string;
	/** Release date, `YYYY-MM-DD`. */
	released?: string;
	/** When models.dev last changed the listing, `YYYY-MM-DD`. */
	lastUpdated?: string;
	/** `deprecated` models are never chosen. */
	status?: string;
	/** The lab that made it (`anthropic`), from its canonical id. */
	lab?: string;
	/** Set only for a specialised model (not a standard chat model). */
	type?: string;
	toolCall?: boolean;
	reasoning?: boolean;
	input?: string[];
	/** Present (false) only when the listing's outputs leave text out. */
	textOutput?: false;
	context?: number;
	/** Maximum input tokens, when below the window. */
	inputLimit?: number;
	/** Maximum output tokens per response. */
	output?: number;
	/** Cache prices and context tiers ride along with a listed input/output price (per million tokens). */
	cost?: {
		input: number;
		output: number;
		cacheRead?: number;
		cacheWrite?: number;
		tiers?: ReturnType<typeof getModelsDevCost>["tiers"];
	};
}

/** The shape of a saved index; an index without it (saved by an earlier Octocode) is used for bare ids and refetched. */
export const CATALOG_VERSION = 2;

/**
 * The index. `models` holds each bare `id` as its lab lists it (else the first provider listing it); `listings` holds
 * each models.dev provider's own listing by id, apart from the bare ids, so a router's bare `anthropic/claude-x` never
 * answers for Anthropic's `claude-x`. A listing entry equal to the bare one is stored as `0`, so the file stays small.
 */
export interface Catalog {
	version?: number;
	fetchedAt: number;
	models: Record<string, CatalogModel>;
	/** By models.dev provider, then id. Absent in an index saved before it was recorded (which is then refetched). */
	listings?: Record<string, Record<string, CatalogModel | 0>>;
	/** The providers models.dev lists: only their models' missing prices are filled from it. */
	providers: string[];
	/**
	 * On a partial index (`partialCatalog`, never saved): every bare id the whole index holds, and the whole index, read
	 * for a bare id or a listing the partial one lacks, so a lookup answers what the whole index would.
	 */
	partial?: { bareIds: ReadonlySet<string>; whole: () => Catalog | undefined };
}

/**
 * A partial index: some providers' listings whole (`listings`, entries resolved, none `0`), some bare entries, the
 * models.dev providers and the whole index's bare ids, from the small file beside the index. What it lacks is read from
 * `whole`.
 */
export function partialCatalog(
	parts: {
		fetchedAt: number;
		listings: Catalog["listings"];
		providers: string[];
		bareIds: readonly string[];
		bare: Catalog["models"];
	},
	whole: () => Catalog | undefined,
): Catalog {
	return {
		version: CATALOG_VERSION,
		fetchedAt: parts.fetchedAt,
		models: parts.bare,
		listings: parts.listings,
		providers: parts.providers,
		partial: { bareIds: new Set(parts.bareIds), whole },
	};
}

/** The bare entry for `id`; a partial index reads the whole index for an id it knows the whole one holds. */
function bareModel(catalog: Catalog, id: string): CatalogModel | undefined {
	const own = catalog.models[id];
	if (own || !catalog.partial?.bareIds.has(id)) return own;
	return catalog.partial.whole()?.models[id];
}

/** `provider`'s own listing; a partial index reads the whole index for a models.dev provider it does not hold. */
function ownListing(catalog: Catalog, provider: string): Record<string, CatalogModel | 0> | undefined {
	const own = catalog.listings?.[provider];
	if (own || !catalog.partial || !catalog.providers.includes(provider)) return own;
	return catalog.partial.whole()?.listings?.[provider];
}

/** Whether the index has the current shape; an older one is used for bare ids only and refetched. */
export const isCurrentCatalog = (catalog: Catalog): boolean =>
	catalog.version === CATALOG_VERSION && catalog.listings !== undefined;

/** One models.dev provider's listing by id, as catalog updates read it (`merge.ts`); undefined when models.dev has none. */
export type CatalogListings = (provider: string) => Readonly<Record<string, CatalogModel>> | undefined;

const str = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : undefined);
const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** `{ [key]: value }`, or nothing when the value is missing, so an absent field is not written. */
function field<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

function price(raw: Partial<ModelsDevModel>): CatalogModel["cost"] {
	const cost = isRecord(raw.cost) ? raw.cost : undefined;
	const input = finite(cost?.input);
	const output = finite(cost?.output);
	if (!cost || input === undefined || output === undefined) return undefined;
	return {
		input,
		output,
		...field("cacheRead", finite(cost.cache_read)),
		...field("cacheWrite", finite(cost.cache_write)),
		...field("tiers", Array.isArray(cost.tiers) ? getModelsDevCost(raw.cost).tiers : undefined),
	};
}

function entry(raw: Partial<ModelsDevModel>): CatalogModel {
	const limit = asRecord(raw.limit);
	const input =
		isRecord(raw.modalities) && Array.isArray(raw.modalities.input)
			? raw.modalities.input.filter((item) => typeof item === "string")
			: undefined;
	const context = finite(limit.context);
	const inputLimit = finite(limit.input);
	const output = finite(limit.output);
	const canonical = str(raw.canonical_model_id);
	return {
		...field("name", str(raw.name)),
		...field("knowledge", str(raw.knowledge)),
		...field("family", str(raw.family)),
		...field("released", str(raw.release_date)),
		...field("lastUpdated", str(raw.last_updated)),
		...field("status", str(raw.status)),
		...field("lab", canonical?.includes("/") ? canonical.split("/")[0] : undefined),
		...field("type", isModelsDevChat(raw) ? undefined : str(raw.type)),
		...(typeof raw.tool_call === "boolean" ? { toolCall: raw.tool_call } : {}),
		...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
		...field("input", input),
		...(isRecord(raw.modalities) && !modelsDevTextOutput(raw) ? { textOutput: false as const } : {}),
		...field("context", context === 0 ? undefined : context),
		...field("inputLimit", inputLimit === 0 ? undefined : inputLimit),
		...field("output", output === 0 ? undefined : output),
		...field("cost", price(raw)),
	};
}

/** The index of models.dev's `api.json` (providers, each with its models). */
export function indexCatalog(api: unknown, fetchedAt: number): Catalog {
	const entries: Array<[string, string, CatalogModel]> = [];
	const bare = new Map<string, { model: CatalogModel; lab: boolean }>();
	const listings: Record<string, Record<string, CatalogModel | 0>> = {};
	for (const [provider, raw] of Object.entries(asRecord(api))) {
		if (!isRecord(raw) || !isRecord(raw.models)) continue;
		listings[provider] = {};
		for (const [id, value] of Object.entries(raw.models)) {
			if (!isRecord(value)) continue;
			const model = entry(value);
			entries.push([provider, id, model]);
			// A bare id resolves to the model's own lab first (`anthropic/claude-…` listed by `anthropic`), else the first.
			const canonical = str(value.canonical_model_id);
			const lab = canonical?.startsWith(`${provider}/`) ?? false;
			const seen = bare.get(id);
			if (!seen || (lab && !seen.lab)) bare.set(id, { model, lab });
		}
	}
	const models: Record<string, CatalogModel> = Object.fromEntries([...bare].map(([id, { model }]) => [id, model]));
	for (const [provider, id, model] of entries) {
		(listings[provider] ??= {})[id] = JSON.stringify(model) === JSON.stringify(models[id]) ? 0 : model;
	}
	// `version` and `fetchedAt` first, `providers` last: `refreshCatalog` checks a saved file's head and tail unparsed.
	return { version: CATALOG_VERSION, fetchedAt, models, listings, providers: Object.keys(asRecord(api)) };
}

/** The entry `provider`'s own listing gives `id`; undefined when that listing has no such id (or the index predates listings). */
export function listedModel(catalog: Catalog, provider: string, id: string): CatalogModel | undefined {
	const own = ownListing(catalog, provider)?.[id];
	return own === 0 ? bareModel(catalog, id) : own;
}

/** The models.dev entry for Octocode's `provider`/`id`: that provider's listing, else the bare id, else the id's last part. */
export function lookup(catalog: Catalog | undefined, provider: string, id: string): CatalogModel | undefined {
	if (!catalog) return undefined;
	const last = id.slice(id.lastIndexOf("/") + 1);
	return listedModel(catalog, provider, id) ?? bareModel(catalog, id) ?? bareModel(catalog, last);
}

/**
 * The price models.dev lists for a model of `provider`, only when it lists that provider: a local or private provider's
 * model (an Ollama `gpt-oss:20b`, priced 0 by Octocode) must not borrow a cloud price through its bare id.
 */
export function listedCost(catalog: Catalog | undefined, provider: string, id: string): CatalogModel["cost"] {
	return catalog?.providers?.includes(provider) ? lookup(catalog, provider, id)?.cost : undefined;
}

/** `provider`'s listing as entries by id; undefined when models.dev lists no such provider or the index predates listings. */
export function listingOf(catalog: Catalog, provider: string): Record<string, CatalogModel> | undefined {
	const own = ownListing(catalog, provider);
	if (!own) return undefined;
	const listing: Record<string, CatalogModel> = {};
	for (const id of Object.keys(own)) {
		const model = listedModel(catalog, provider, id);
		if (model) listing[id] = model;
	}
	return listing;
}

/** The listings of a whole index, for catalog updates. */
export const catalogListings =
	(catalog: Catalog): CatalogListings =>
	(provider) =>
		listingOf(catalog, provider);

/** The models models.dev lists under `provider`, each as that provider lists it; empty for an index without listings. */
export function providerListing(catalog: Catalog | undefined, provider: string): Array<CatalogModel & { id: string }> {
	const listing = catalog && listingOf(catalog, provider);
	return Object.entries(listing ?? {}).map(([id, model]) => ({ ...model, id }));
}
