/**
 * models.json defines custom providers. A provider entry whose id is an official provider's id never merges into or
 * overrides it: host and key of an official provider live in `/providers`. The one narrow path kept is per-model tuning
 * of an official model (`modelOverrides`), limited to compat and limits.
 */

import { builtinProviders } from "@octocodeai/octocode-ai/providers/all";

/** The per-model fields an official provider's `modelOverrides` entry may set. Never host, api or key. */
const OFFICIAL_MODEL_OVERRIDE_FIELDS: readonly string[] = ["compat", "contextWindow", "maxTokens", "inputLimits"];

let officialIds: ReadonlySet<string> | undefined;

/** Ids of the official (built-in) providers. */
function officialProviderIds(): ReadonlySet<string> {
	officialIds ??= new Set(builtinProviders().map((provider) => provider.id));
	return officialIds;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What is wrong with an entry that carries an official provider's id, or undefined when it only tunes models
 * (`modelOverrides` with allowed fields). Names the file and id, never a value.
 */
export function officialEntryProblem(providerId: string, entry: unknown, file: string): string | undefined {
	if (!officialProviderIds().has(providerId)) return undefined;
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
		`so this entry was not loaded (the other providers in the file still load; blocked: ${blocked}). ` +
		`For a custom endpoint, rename the entry (for example "${providerId}-mantle" or "${providerId}-custom") and keep its baseUrl, api and models. ` +
		`To set an official provider's host or key, use /providers. ` +
		`Tuning official models stays possible: keep only "modelOverrides" limited to ${OFFICIAL_MODEL_OVERRIDE_FIELDS.join(", ")}.`
	);
}
