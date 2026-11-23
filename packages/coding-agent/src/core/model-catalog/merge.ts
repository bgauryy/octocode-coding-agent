import type { Api, Model } from "@octocodeai/octocode-ai";
import { modelsDevInput, modelsDevLimits } from "@octocodeai/octocode-ai/catalog/models-dev-fields";
import type { CatalogListings, CatalogModel } from "./index-shape.ts";

/**
 * Catalog updates: what the models.dev index changes in the bundled catalog of one provider, in one place.
 *
 * - The data manifest names the models.dev listing each provider was built from (`zai-coding-plan` for `zai`) and the
 *   ids the generator left out. A provider it does not name only has deprecations flagged, from its own listing.
 * - Bundled wins for wiring (api, baseUrl, compat, headers, auth): only price, limits and flags change.
 * - Price and limits change only for a named provider, and only when the listing changed after the bundled data was
 *   taken. A zero or missing listed price never replaces the bundled one.
 * - A listing marked `deprecated` flags the model; it stays listed.
 * - A new model is added for a named provider only when the generator did not leave its id out, it calls tools, is a
 *   chat model answering in text, has a price, and a bundled model of the same family is listed under the same id: it
 *   clones the newest such sibling's wiring (one with the same id prefix first) and takes id, name, limits, price,
 *   reasoning and modalities from the listing.
 *
 * Offline or with no index there are no updates, and the bundled catalog is used as it is.
 */

/** One provider's source as the data manifest records it (`ModelsDevProviderSource` in `@octocodeai/octocode-ai`). */
interface ProviderModelsDevSource {
	/** The models.dev provider whose listing the bundled models came from. */
	listing: string;
	/** The models.dev provider whose entry of the same id prices a model, when not the listing. */
	prices?: string;
	/** Ids the generator left out: never added. */
	excluded: readonly string[];
}

/** Where the bundled models.dev data came from (the data manifest's stamp). */
export interface BundledModelsDevSource {
	/** When the bundled models.dev data was taken (ms). */
	generatedAt: number;
	/** The providers built from a models.dev listing of their own ids, by Octocode provider id. */
	sources: Readonly<Record<string, ProviderModelsDevSource>>;
}

/** What a catalog update says about one model; absent for a model the index leaves as bundled. */
export interface CatalogUpdate {
	/** `models.dev`: added from the index at runtime, not shipped with Octocode. */
	source?: "models.dev";
	/** models.dev lists it as deprecated: shown dimmed, never chosen by routing. */
	deprecated?: true;
	/** A listing newer than the bundled data replaced its price or limits. */
	repriced?: true;
}

/** One provider's updates, computed once per refresh and applied to every read of its models. */
export interface ProviderCatalogUpdates {
	/** Bundled models with a newer price or limits, by id. */
	replaced: ReadonlyMap<string, Model<Api>>;
	/** Models added from the index. */
	added: readonly Model<Api>[];
	/** What changed, by model id. */
	flags: ReadonlyMap<string, CatalogUpdate>;
}

const time = (date: string | undefined) => (date ? Date.parse(date) : NaN);

function costOf(listed: NonNullable<CatalogModel["cost"]>, base?: Model<Api>["cost"]): Model<Api>["cost"] {
	const tiers = listed.tiers ?? base?.tiers;
	return {
		input: listed.input,
		output: listed.output,
		cacheRead: listed.cacheRead ?? base?.cacheRead ?? 0,
		cacheWrite: listed.cacheWrite ?? base?.cacheWrite ?? 0,
		...(tiers ? { tiers } : {}),
	};
}

/** A model's input limits without its token ceiling. */
function otherInputLimits(model: Pick<Model<Api>, "inputLimits">): Model<Api>["inputLimits"] {
	const { maxInputTokens: _tokens, ...other } = model.inputLimits ?? {};
	return other;
}

/** The window, output ceiling and input limit a listing gives, each kept from `base` when the listing has none. */
function limitsOf(listed: CatalogModel, base: Pick<Model<Api>, "contextWindow" | "maxTokens" | "inputLimits">) {
	const limits = modelsDevLimits(
		{ context: listed.context, input: listed.inputLimit, output: listed.output },
		{ contextWindow: base.contextWindow, maxTokens: base.maxTokens },
	);
	// A listed window comes with its own input limit (or none); without one, the base's stays.
	const inputLimits = limits.inputLimits
		? { ...otherInputLimits(base), ...limits.inputLimits }
		: listed.context !== undefined
			? otherInputLimits(base)
			: base.inputLimits;
	return {
		contextWindow: limits.contextWindow,
		maxTokens: limits.maxTokens,
		...(inputLimits && Object.keys(inputLimits).length > 0 ? { inputLimits } : {}),
	};
}

/** The price and limit fields in a fixed order, so two models compare by value. */
const priceAndLimits = ({ cost, contextWindow, maxTokens, inputLimits }: Model<Api>) =>
	JSON.stringify([
		[cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.tiers],
		contextWindow,
		maxTokens,
		inputLimits?.maxInputTokens,
	]);

/** A listed price that prices something: zero or missing rates are no price. */
const positive = (cost: CatalogModel["cost"]) => (cost && cost.input + cost.output > 0 ? cost : undefined);

function repriced(model: Model<Api>, listed: CatalogModel, cost: CatalogModel["cost"]): Model<Api> | undefined {
	const { inputLimits: _old, ...rest } = model;
	const next: Model<Api> = {
		...rest,
		...limitsOf(listed, model),
		cost: cost ? costOf(cost, model.cost) : model.cost,
	};
	return priceAndLimits(next) === priceAndLimits(model) ? undefined : next;
}

/** Whether a listing may become a new model: tool calls, a chat model answering in text, not deprecated, a family. */
const addable = (listed: CatalogModel): listed is CatalogModel & { family: string } =>
	listed.toolCall === true &&
	listed.type === undefined &&
	listed.textOutput !== false &&
	listed.status !== "deprecated" &&
	listed.family !== undefined;

function cloned(
	id: string,
	listed: CatalogModel,
	cost: NonNullable<CatalogModel["cost"]>,
	sibling: Model<Api>,
): Model<Api> {
	const { inputLimits: _old, thinkingLevelMap, ...wiring } = sibling;
	const reasoning = listed.reasoning ?? sibling.reasoning;
	return {
		...wiring,
		id,
		name: listed.name ?? id,
		reasoning,
		...(reasoning && thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: listed.input ? modelsDevInput({ input: listed.input }) : sibling.input,
		cost: costOf(cost),
		// The sibling's other input limits (image sizes) are wiring; its token limit is not.
		...limitsOf(listed, { contextWindow: 4096, maxTokens: 4096, inputLimits: otherInputLimits(sibling) }),
	};
}

/** The updates the index makes to `provider`'s bundled chat models. */
export function catalogUpdates(
	provider: string,
	bundled: readonly Model<Api>[],
	listings: CatalogListings | undefined,
	bundledSource: BundledModelsDevSource | undefined,
): ProviderCatalogUpdates {
	const replaced = new Map<string, Model<Api>>();
	const added: Model<Api>[] = [];
	const flags = new Map<string, CatalogUpdate>();
	/** The provider's recorded source; undefined for a provider the manifest does not name (flags only). */
	const source = bundledSource?.sources[provider];
	const listing = listings?.(source?.listing ?? provider);
	if (!listing) return { replaced, added, flags };
	const prices = source?.prices ? listings?.(source.prices) : undefined;
	/** The price of a listed id: the price listing's entry of that id first (as the generator prices it), else its own. */
	const priceOf = (id: string, listed: CatalogModel) => positive(prices?.[id]?.cost ?? listed.cost);
	const since = source ? bundledSource?.generatedAt : undefined;
	const changed = (id: string, listed: CatalogModel) =>
		since !== undefined && Math.max(time(listed.lastUpdated) || 0, time(prices?.[id]?.lastUpdated) || 0) > since;
	const known = new Set(bundled.map((model) => model.id));
	/** Bundled models listed under their own id, by family: the siblings a new model may clone. */
	const families = new Map<string, Array<{ model: Model<Api>; listed: CatalogModel }>>();

	for (const model of bundled) {
		const listed = listing[model.id];
		if (!listed) continue;
		if (listed.family) {
			const members = families.get(listed.family) ?? [];
			members.push({ model, listed });
			families.set(listed.family, members);
		}
		const flag: CatalogUpdate = listed.status === "deprecated" ? { deprecated: true } : {};
		if (changed(model.id, listed)) {
			const next = repriced(model, listed, priceOf(model.id, listed));
			if (next) {
				replaced.set(model.id, next);
				flag.repriced = true;
			}
		}
		if (flag.deprecated || flag.repriced) flags.set(model.id, flag);
	}
	if (!source) return { replaced, added, flags };

	const excluded = new Set(source.excluded);
	for (const [id, listed] of Object.entries(listing)) {
		if (known.has(id) || excluded.has(id) || !addable(listed)) continue;
		const cost = priceOf(id, listed);
		if (!cost) continue;
		// A sibling with the same id prefix first (`eu.` on Bedrock, `workers-ai/` on a gateway): its endpoint fits.
		const prefix = /^[^./]*[./]/.exec(id)?.[0] ?? "";
		const shares = (other: string) => Number(prefix !== "" && other.startsWith(prefix));
		const newest = families
			.get(listed.family)
			?.toSorted(
				(a, b) =>
					shares(b.model.id) - shares(a.model.id) ||
					(time(b.listed.released) || 0) - (time(a.listed.released) || 0) ||
					b.model.id.localeCompare(a.model.id),
			)[0];
		if (!newest) continue;
		added.push(cloned(id, listed, cost, newest.model));
		flags.set(id, { source: "models.dev" });
	}
	return { replaced, added, flags };
}

/** `models` with the updates applied: replaced entries swapped in place, added models after the bundled ones. */
export function applyCatalogUpdates<T extends { id: string; type?: string }>(
	models: readonly T[],
	updates: ProviderCatalogUpdates | undefined,
): readonly T[] {
	if (!updates || (updates.replaced.size === 0 && updates.added.length === 0)) return models;
	const isChat = (model: T) => model.type === undefined || model.type === "chat";
	const present = new Set(models.filter(isChat).map((model) => model.id));
	return [
		...models.map((model) => (isChat(model) ? ((updates.replaced.get(model.id) as T | undefined) ?? model) : model)),
		...(updates.added.filter((model) => !present.has(model.id)) as unknown as T[]),
	];
}
