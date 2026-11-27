import { isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * Where a built-in provider's bundled models came from on models.dev, as the data manifest records it. The generator
 * writes it (`scripts/model-data.ts`); the runtime catalog update reads it, so a provider is repriced or given new models
 * only from the listing its bundled models were built from, and never gets an id the generator left out.
 */

/** One built-in provider whose bundled model ids are a models.dev listing's own ids. */
export interface ModelsDevProviderSource {
	/** The models.dev provider whose listing the bundled models came from (`zai-coding-plan` for Octocode's `zai`). */
	listing: string;
	/** The models.dev provider whose entry of the same id prices a model, when not the listing (a plan lists 0). */
	prices?: string;
	/** Ids the generator leaves out of this provider (unsupported, end of life, profile only, no tool calls, ...). */
	excluded: readonly string[];
}

/** The manifest's `modelsDevSources`: by Octocode provider id. A provider absent here gets no price or model additions. */
export type ModelsDevSources = Readonly<Record<string, ModelsDevProviderSource>>;

/** What the data manifest says about the bundled models.dev data. */
export interface ModelsDevManifestSource {
	/** When the bundled models.dev data was taken (ms). */
	generatedAt: number;
	sources: ModelsDevSources;
}

const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

function parseSource(value: unknown): ModelsDevProviderSource | undefined {
	if (!isRecord(value) || typeof value.listing !== "string" || value.listing === "") return undefined;
	if (value.prices !== undefined && (typeof value.prices !== "string" || value.prices === "")) return undefined;
	if (!isStringList(value.excluded)) return undefined;
	return {
		listing: value.listing,
		...(typeof value.prices === "string" ? { prices: value.prices } : {}),
		excluded: value.excluded,
	};
}

/** The manifest's `modelsDevSources`, or undefined when it is absent or any entry is malformed (never a partial guess). */
export function parseModelsDevSources(value: unknown): ModelsDevSources | undefined {
	if (!isRecord(value)) return undefined;
	const sources: Record<string, ModelsDevProviderSource> = {};
	for (const [provider, entry] of Object.entries(value)) {
		const source = parseSource(entry);
		if (!source) return undefined;
		sources[provider] = source;
	}
	return sources;
}

/**
 * The models.dev stamp of a data manifest: when its models.dev data was taken and each provider's source. Undefined for a
 * manifest without both fields (hydrated before they were recorded): runtime updates then add and reprice nothing.
 */
export function readModelsDevManifestSource(
	manifest: Readonly<Record<string, unknown>>,
): ModelsDevManifestSource | undefined {
	const at = manifest.modelsDevGeneratedAt;
	const generatedAt = typeof at === "string" ? Date.parse(at) : NaN;
	const sources = parseModelsDevSources(manifest.modelsDevSources);
	return Number.isNaN(generatedAt) || !sources ? undefined : { generatedAt, sources };
}
