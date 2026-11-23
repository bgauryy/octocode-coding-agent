/**
 * models.json defines custom providers. A provider entry whose id is an official provider's id never merges into or
 * overrides it: host and key of an official provider live in `/providers`. The one narrow path kept is per-model tuning
 * of an official model (`modelOverrides`), limited to compat, limits and price (`cost`, for negotiated or enterprise
 * rates; `/model` details mark such a price "(your price)").
 */

import { getBuiltinProviders } from "@octocodeai/octocode-ai/providers/all";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/** The per-model fields an official provider's `modelOverrides` entry may set, nested fields included. Never host, api, key or headers. */
const OFFICIAL_MODEL_OVERRIDE_FIELDS: readonly string[] = [
	"compat",
	"contextWindow",
	"maxTokens",
	"inputLimits",
	"cost",
];

const officialIds: ReadonlySet<string> = new Set(getBuiltinProviders());

/**
 * What is wrong with an entry that carries an official provider's id, or undefined when it only tunes models
 * (`modelOverrides` with allowed fields). Any other field refuses the whole entry, its allowed overrides included: a host
 * or key says the entry meant another endpoint, whose prices and limits must not land on the official one. Names the
 * file and id, never a value.
 */
export function officialEntryProblem(providerId: string, entry: unknown, file: string): string | undefined {
	if (!officialIds.has(providerId)) return undefined;
	const fields = isRecord(entry) ? Object.keys(entry) : [];
	const extraProviderFields = fields.filter((field) => field !== "modelOverrides");
	const overrides = isRecord(entry) && isRecord(entry.modelOverrides) ? entry.modelOverrides : {};
	const extraModelFields = Object.entries(overrides).flatMap(([modelId, override]) =>
		isRecord(override)
			? Object.keys(override)
					.filter((field) => !OFFICIAL_MODEL_OVERRIDE_FIELDS.includes(field))
					.map((field) => `modelOverrides.${modelId}.${field}`)
			: [],
	);
	if (extraProviderFields.length === 0 && extraModelFields.length === 0) return undefined;
	const blocked = [...extraProviderFields, ...extraModelFields].join(", ");
	return (
		`providers.${providerId} in ${file}: "${providerId}" is an official provider, and models.json defines custom providers only, ` +
		`so this entry was not loaded, its modelOverrides included (blocked: ${blocked}; the other providers in the file still load). ` +
		`For a custom endpoint, rename the entry (for example "${providerId}-mantle" or "${providerId}-custom") and keep its baseUrl, api and models. ` +
		`To set an official provider's host or key, use /providers. ` +
		`To tune official models, keep only "modelOverrides" in this entry, with ${OFFICIAL_MODEL_OVERRIDE_FIELDS.join(", ")} (never host, api, key or headers).`
	);
}
