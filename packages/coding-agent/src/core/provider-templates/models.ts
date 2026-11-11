import type { Api, Model } from "@octocodeai/octocode-ai";
import type { ModelsJsonModel } from "../model-config.ts";
import type { ProviderTemplate } from "./templates.ts";

/** One model a catalog lists for a host (prices per million tokens), as the layer that owns the catalog reads it. */
export interface ListedModel {
	id: string;
	context?: number;
	reasoning?: boolean;
	toolCall?: boolean;
	input?: readonly string[];
	cost?: { input: number; output: number };
	status?: string;
}

/**
 * Where a template's models come from. Core owns neither: the vendor models are the built-in providers (through
 * `vendorChatModels`), and the host listing is the models.dev catalog, which the feature layer reads and passes in.
 */
export interface TemplateModelSources {
	vendorModels?: (api: Api) => readonly Model<Api>[];
	/** The models a catalog lists for `catalog` (a models.dev provider id), each with that host's metadata. */
	listed?: (catalog: string) => readonly ListedModel[];
}

/** A model a template offers: its id and, for the picker, what is known about it. */
export interface TemplateModel {
	id: string;
	name?: string;
	contextWindow?: number;
	/** `vendor`: inherits the built-in model when models.json loads; `catalog`: metadata written into the entry. */
	source: "vendor" | "catalog";
}

/** A listed model an agent can use: tool calling not ruled out and not deprecated. */
const usable = (model: ListedModel): boolean => model.toolCall !== false && model.status !== "deprecated";

/** The models a template offers, vendor models first (gateways), then the host's catalog listing (hosted services). */
export function templateModels(template: ProviderTemplate, sources: TemplateModelSources): TemplateModel[] {
	const vendor = (sources.vendorModels?.(template.api) ?? []).map((model): TemplateModel => ({
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		source: "vendor",
	}));
	const listed = template.catalog
		? (sources.listed?.(template.catalog) ?? [])
				.filter(usable)
				.map((model): TemplateModel => ({ id: model.id, contextWindow: model.context, source: "catalog" }))
		: [];
	const seen = new Set<string>();
	return [...vendor, ...listed]
		.filter((model) => !seen.has(model.id) && seen.add(model.id))
		.sort((a, b) => Number(a.source === "catalog") - Number(b.source === "catalog") || a.id.localeCompare(b.id));
}

/** A catalog model's metadata as `models.json` fields; a missing number keeps Octocode's default. */
function listedEntry(model: ListedModel): ModelsJsonModel {
	const input = (model.input ?? []).filter((kind): kind is "text" | "image" => kind === "text" || kind === "image");
	return {
		id: model.id,
		...(model.context ? { contextWindow: model.context } : {}),
		...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
		...(input.includes("text") ? { input } : {}),
		...(model.cost
			? { cost: { input: model.cost.input, output: model.cost.output, cacheRead: 0, cacheWrite: 0 } }
			: {}),
	};
}

/**
 * The `models` entries for the chosen ids. An id the host's catalog lists carries that metadata (context window,
 * thinking, image input, price); any other id is written bare, so a vendor id inherits the built-in model when
 * `models.json` loads and its fields stay in step with Octocode's catalog.
 */
export function templateModelEntries(
	template: ProviderTemplate,
	ids: readonly string[],
	sources: TemplateModelSources,
): ModelsJsonModel[] {
	const listed = new Map(
		(template.catalog ? (sources.listed?.(template.catalog) ?? []) : []).map((model) => [model.id, model]),
	);
	return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].map((id) => {
		const model = listed.get(id);
		return model ? listedEntry(model) : { id };
	});
}
