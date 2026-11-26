/**
 * models.json defines custom providers. A provider entry whose id is an official provider's id never merges into or
 * overrides how that provider is reached: host, API, key and headers of an official provider live in `/providers`. Three
 * things stay open because they are not credentials: the provider's `profile` (its cache and request-format family,
 * which moves no key or host), per-model tuning of official models (`modelOverrides`, and
 * `defaults` for all of them), limited to compat, limits and price (`cost`, for negotiated or enterprise rates;
 * `/model` details mark such a price "(your price)"), and the throttle (`requestsPerMinute`, `tokensPerMinute`) at
 * provider or model level.
 */

import { getBuiltinProviders } from "@octocodeai/octocode-ai/providers/all";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/** The model fields an official provider's `defaults` and `modelOverrides` may set, nested fields included. */
const OFFICIAL_TUNING_FIELDS: readonly string[] = ["compat", "contextWindow", "maxTokens", "inputLimits", "cost"];
/** The throttle fields an official provider may set at provider level and in `modelOverrides`. */
const OFFICIAL_RATE_FIELDS: readonly string[] = ["requestsPerMinute", "tokensPerMinute"];
/** The provider-level fields an official entry may carry. */
const OFFICIAL_PROVIDER_FIELDS: readonly string[] = ["modelOverrides", "defaults", "profile", ...OFFICIAL_RATE_FIELDS];
/** A `modelOverrides` entry's allowed fields: tuning and throttle. */
const OFFICIAL_OVERRIDE_FIELDS: readonly string[] = [...OFFICIAL_TUNING_FIELDS, ...OFFICIAL_RATE_FIELDS];

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
	const extraProviderFields = fields.filter((field) => !OFFICIAL_PROVIDER_FIELDS.includes(field));
	const defaults = isRecord(entry) && isRecord(entry.defaults) ? entry.defaults : {};
	const extraDefaultFields = Object.keys(defaults)
		.filter((field) => !OFFICIAL_TUNING_FIELDS.includes(field))
		.map((field) => `defaults.${field}`);
	const overrides = isRecord(entry) && isRecord(entry.modelOverrides) ? entry.modelOverrides : {};
	const extraModelFields = Object.entries(overrides).flatMap(([modelId, override]) =>
		isRecord(override)
			? Object.keys(override)
					.filter((field) => !OFFICIAL_OVERRIDE_FIELDS.includes(field))
					.map((field) => `modelOverrides.${modelId}.${field}`)
			: [],
	);
	if (extraProviderFields.length === 0 && extraModelFields.length === 0 && extraDefaultFields.length === 0)
		return undefined;
	const blocked = [...extraProviderFields, ...extraDefaultFields, ...extraModelFields].join(", ");
	return (
		`providers.${providerId} in ${file}: "${providerId}" is an official provider, and models.json defines custom providers only, ` +
		`so this entry was not loaded, its tuning included (blocked: ${blocked}; the other providers in the file still load). ` +
		`For a custom endpoint, rename the entry (for example "${providerId}-mantle" or "${providerId}-custom") and keep its baseUrl, api and models. ` +
		`To set an official provider's host or key, use /providers. ` +
		`To tune official models or throttle them, keep only "modelOverrides" and "defaults" (${OFFICIAL_TUNING_FIELDS.join(", ")}) and "requestsPerMinute" / "tokensPerMinute" (also allowed in modelOverrides) and "profile", never host, api, key, headers, auth, env or models.`
	);
}
